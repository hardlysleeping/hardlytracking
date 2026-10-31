//! The desktop shell.
//!
//! Thin on purpose: it owns the window, the loopback HTTP client the webview cannot make itself, and
//! the extension host process (`runtime.rs`). Everything the user sees is the same Svelte build the
//! browser and the phone run.

mod runtime;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // The extension host is not ours to add CORS headers to, so loopback calls go through Rust.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(runtime::RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            runtime::mihon_runtime_start,
            runtime::mihon_runtime_status,
            runtime::mihon_runtime_stop,
        ])
        .build(tauri::generate_context!())
        .expect("the app configuration is invalid")
        .run(|app, event| {
            // A child that outlives the window holds the port, and the next launch fails with
            // "address already in use" for no visible reason.
            if let tauri::RunEvent::Exit = event {
                runtime::stop(&app.state::<runtime::RuntimeState>());
            }
        });
}
