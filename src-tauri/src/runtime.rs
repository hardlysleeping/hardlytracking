//! The desktop extension host: a JVM this app starts, and the app talks to over loopback.
//!
//! The iPhone build loads a JVM into its own process because iOS forbids spawning one. A desktop can
//! do the simple thing instead: start `MExtensionServer` as a child, wait until `/capabilities`
//! answers, and hand the webview a base URL. The protocol is the same one a self-hosted server
//! speaks, so `DalvikClient` and every source above it are unchanged.
//!
//! Three rules, each of which is a bug if broken:
//!
//! 1. **The child is ours to reap.** It is killed on exit and on an explicit stop; an orphan holding
//!    the port makes the next launch fail with "address in use" and no explanation.
//! 2. **A start is not a server.** The process existing proves nothing — the JVM loads a 100 MB
//!    shadow jar and converts extension APKs before it listens, so readiness is `/capabilities`
//!    answering 200, not `spawn()` returning.
//! 3. **A failure has to be readable.** The child's stderr goes to a log file and the path is in the
//!    error, because "the extension host did not start" with nothing else is useless on someone
//!    else's machine.

use std::fs::File;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// How long the first start may take. The jar is large and the first launch converts extensions.
const START_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct RuntimeState {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
}

#[derive(Serialize)]
pub struct RuntimeStatus {
    pub running: bool,
    pub port: u16,
    pub base_url: String,
}

fn info(port: u16) -> RuntimeStatus {
    RuntimeStatus {
        running: port > 0,
        port,
        base_url: if port > 0 { format!("http://127.0.0.1:{port}") } else { String::new() },
    }
}

/// The running port, or `None` when the child is gone — a dead process is not a runtime.
fn running_port(state: &RuntimeState) -> Option<u16> {
    let mut child = state.child.lock().ok()?;
    let child = child.as_mut()?;
    match child.try_wait() {
        Ok(None) => {
            let port = *state.port.lock().ok()?;
            if port > 0 {
                Some(port)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .ok()
}

/// The port to serve on: the one asked for, if nothing is on it, else any free one.
///
/// A caller that names a port (the phone pins 8747 so a stale pairing cannot point elsewhere) is
/// honoured only while the port is actually free. Otherwise every launch after a crash is a
/// `BindException` in a log file — the app would look like it has no extension host at all. The
/// caller reads the port back from the answer, so moving is safe here in a way it is not on iOS.
fn usable_port(preferred: Option<u16>) -> Option<u16> {
    if let Some(port) = preferred.filter(|value| *value > 0) {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    free_port()
}

/// Does `/capabilities` answer 200 on this port? A raw request keeps a whole HTTP client out of the
/// binary for one health check.
fn serving(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = "GET /capabilities HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

/// The jar, from the first place that has one: an explicit override, the bundle's resources, or
/// beside the executable. The error names every path tried, because "not found" alone is a guess.
fn resolve_jar(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(explicit) = std::env::var("HARDLYTRACKING_RUNTIME_JAR") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("runtime").join("runner.jar"));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("runtime").join("runner.jar"));
        }
    }
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "no extension host jar was found. Put runner.jar in the app's runtime/ folder, or set \
         HARDLYTRACKING_RUNTIME_JAR. Tried: {}",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// The JVM that runs the host: an override, the JRE the app carries, or whatever `java` is on PATH.
///
/// The bundled JRE comes second so a developer can point at their own build, and before PATH because
/// the app must not depend on the machine having Java installed at all — that is the difference
/// between an installer that works and one that opens a window with no extension host. The bundle is
/// per platform (`scripts/prepare-runtime.mjs`), so the path is the same everywhere except the `.exe`.
fn java_candidates(resources: Option<&Path>, executable: Option<&Path>) -> Vec<PathBuf> {
    let binary = if cfg!(windows) { "java.exe" } else { "java" };
    let mut candidates = Vec::new();
    if let Ok(explicit) = std::env::var("HARDLYTRACKING_JAVA") {
        if !explicit.trim().is_empty() {
            candidates.push(PathBuf::from(explicit));
        }
    }
    if let Some(directory) = resources {
        candidates.push(directory.join("runtime").join("jre").join("bin").join(binary));
    }
    if let Some(directory) = executable.and_then(|path| path.parent()) {
        candidates.push(directory.join("runtime").join("jre").join("bin").join(binary));
    }
    // Last: a system JVM. Named rather than resolved, so the spawn error can say which one was tried.
    candidates.push(PathBuf::from(binary));
    candidates
}

fn resolve_java(app: &AppHandle) -> PathBuf {
    let resources = app.path().resource_dir().ok();
    let executable = std::env::current_exe().ok();
    let candidates = java_candidates(resources.as_deref(), executable.as_deref());
    for candidate in &candidates {
        // The bare name is the PATH fallback: it has no parent worth checking, and `is_file` on a
        // relative name would test the working directory instead of PATH.
        if candidate.components().count() == 1 || candidate.is_file() {
            return candidate.clone();
        }
    }
    candidates
        .last()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("java"))
}

/// Where the JVM keeps its own state: one folder per user, created on demand.
fn runtime_home(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no writable app-data directory: {error}"))?
        .join("runtime");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create {}: {error}", directory.display()))?;
    Ok(directory)
}

fn log_file(home: &Path) -> PathBuf {
    home.join("extension-host.log")
}

#[tauri::command]
pub fn mihon_runtime_status(state: tauri::State<'_, RuntimeState>) -> RuntimeStatus {
    info(running_port(&state).unwrap_or(0))
}

#[tauri::command]
pub fn mihon_runtime_start(
    app: AppHandle,
    state: tauri::State<'_, RuntimeState>,
    port: Option<u16>,
) -> Result<RuntimeStatus, String> {
    if let Some(existing) = running_port(&state) {
        return Ok(info(existing));
    }
    // A dead child from a previous attempt is cleared before a new one is started.
    stop(&state);

    let jar = resolve_jar(&app)?;
    let home = runtime_home(&app)?;
    let chosen = usable_port(port).unwrap_or(0);
    if chosen == 0 {
        return Err("no free loopback port could be found".to_string());
    }

    let log_path = log_file(&home);
    let log = File::create(&log_path)
        .map_err(|error| format!("could not write {}: {error}", log_path.display()))?;
    let stderr = log
        .try_clone()
        .map_err(|error| format!("could not open the host log twice: {error}"))?;

    let java = resolve_java(&app);
    let mut command = Command::new(&java);
    command
        .arg("-jar")
        .arg(&jar)
        .arg(chosen.to_string())
        .arg(&home)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));

    // Rule 1, the hard half: `RunEvent::Exit` covers a window being closed, not a crash, a SIGTERM
    // or a `kill -9`. Without this the JVM survives its app, holds the port, and the next launch has
    // to move aside. A parent-death signal is the only thing that also covers SIGKILL.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id();
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // The parent can die between fork and prctl, and the signal would then never come.
                if libc::getppid() as u32 != parent {
                    return Err(std::io::Error::other("the app exited while starting the host"));
                }
                Ok(())
            });
        }
    }

    let child = command.spawn().map_err(|error| {
        format!(
            "could not start {} with {}: {error}. The app carries its own JRE; if it is missing, run \
             `node scripts/prepare-runtime.mjs`, or set HARDLYTRACKING_JAVA to a Java 21 binary.",
            java.display(),
            jar.display()
        )
    })?;

    {
        let mut guard = state
            .child
            .lock()
            .map_err(|_| "the runtime state is poisoned".to_string())?;
        *guard = Some(child);
        let mut port_guard = state
            .port
            .lock()
            .map_err(|_| "the runtime state is poisoned".to_string())?;
        *port_guard = chosen;
    }

    // Rule 2: the process is not the server. Wait for the endpoint, and stop waiting the moment the
    // child dies — a JVM that exits during bootstrap must not look like a slow start for two minutes.
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if serving(chosen) {
            return Ok(info(chosen));
        }
        let exited = {
            let mut guard = state
                .child
                .lock()
                .map_err(|_| "the runtime state is poisoned".to_string())?;
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some(status.to_string()),
                    Ok(None) => None,
                    Err(error) => Some(error.to_string()),
                },
                None => Some("the child disappeared".to_string()),
            }
        };
        if let Some(status) = exited {
            stop(&state);
            return Err(format!(
                "the extension host exited before it served anything ({status}). Its log is {}",
                log_path.display()
            ));
        }
        if Instant::now() >= deadline {
            stop(&state);
            return Err(format!(
                "the extension host did not answer /capabilities within {}s. Its log is {}",
                START_TIMEOUT.as_secs(),
                log_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[tauri::command]
pub fn mihon_runtime_stop(state: tauri::State<'_, RuntimeState>) -> Result<(), String> {
    stop(&state);
    Ok(())
}

/// Rule 1: reap it. Called by the stop command and on the app's exit event.
pub fn stop(state: &RuntimeState) {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Ok(mut port) = state.port.lock() {
        *port = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bundled JRE has to win over PATH, or an installer on a machine without Java opens a window
    /// with no extension host — and the app cannot tell the difference from "the source is broken".
    #[test]
    fn the_jre_the_app_carries_comes_before_path() {
        let candidates = java_candidates(
            Some(Path::new("/app/resources")),
            Some(Path::new("/app/bin/hardlytracking")),
        );
        let names: Vec<String> = candidates.iter().map(|path| path.display().to_string()).collect();
        let bundled = if cfg!(windows) {
            "/app/resources/runtime/jre/bin/java.exe"
        } else {
            "/app/resources/runtime/jre/bin/java"
        };
        assert_eq!(names[0], bundled, "resources first: {names:?}");
        // Beside the executable is the unpacked-archive layout, and it comes next.
        let beside = if cfg!(windows) {
            "/app/bin/runtime/jre/bin/java.exe"
        } else {
            "/app/bin/runtime/jre/bin/java"
        };
        assert_eq!(names[1], beside, "then beside the exe: {names:?}");
        // PATH is the last resort and stays a bare name, so the spawn error can name it.
        assert_eq!(names.last().map(String::as_str), Some(if cfg!(windows) { "java.exe" } else { "java" }));
    }

    #[test]
    fn an_override_beats_the_bundle() {
        // `set_var` is unsafe in edition 2024 and process-wide either way; this test is the only one
        // that reads it, and it restores the value.
        let previous = std::env::var("HARDLYTRACKING_JAVA").ok();
        unsafe { std::env::set_var("HARDLYTRACKING_JAVA", "/opt/jdk-21/bin/java") };
        let candidates = java_candidates(None, None);
        let first = candidates.first().map(|path| path.display().to_string());
        match previous {
            Some(value) => unsafe { std::env::set_var("HARDLYTRACKING_JAVA", value) },
            None => unsafe { std::env::remove_var("HARDLYTRACKING_JAVA") },
        }
        assert_eq!(first.as_deref(), Some("/opt/jdk-21/bin/java"));
    }
}
