//! Saving a file the reader asked for.
//!
//! The web view has no downloads of its own: WebKitGTK drops an `<a download>` click unless the
//! shell installs a download handler, and the app never did. So a backup export answered "saved"
//! with nothing on disk. This is the smallest honest answer — the bytes arrive through `invoke`,
//! they are written into the OS Downloads directory, and the path goes back to the page so it can
//! say where the file is instead of guessing.
//!
//! Two rules:
//!
//! 1. **The name is a name, not a path.** A name with a separator in it would let the page write
//!    anywhere the process can, so separators are stripped and an empty result is refused.
//! 2. **A failure is a sentence.** The page shows what this returns, so "permission denied" has to
//!    arrive as words rather than a silent `Err(())`.

use std::fs;
use std::path::PathBuf;

use tauri::Manager;

/// Keep only the last path segment, and refuse anything that is not a plain file name.
fn safe_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let last = trimmed.split(['/', '\\']).next_back().unwrap_or("");
    let cleaned = last.trim_start_matches('.');
    if cleaned.is_empty() {
        return Err("that file has no name to save it under".into());
    }
    Ok(cleaned.to_string())
}

/// Where to put it: Downloads when the platform names one, the app's data directory otherwise.
fn target_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app.path();
    if let Ok(downloads) = path.download_dir() {
        if downloads.is_dir() {
            return Ok(downloads);
        }
    }
    let fallback = path
        .app_data_dir()
        .map_err(|error| format!("this build has no folder to save into: {error}"))?;
    fs::create_dir_all(&fallback)
        .map_err(|error| format!("could not create {}: {error}", fallback.display()))?;
    Ok(fallback)
}

/// Write `bytes` as `name` and answer the absolute path that was written.
#[tauri::command]
pub fn save_file(app: tauri::AppHandle, name: String, bytes: Vec<u8>) -> Result<String, String> {
    let file = safe_name(&name)?;
    let dir = target_dir(&app)?;
    let mut target = dir.join(&file);
    // Never overwrite: two exports in one minute are two files, and the second is not the first.
    if target.exists() {
        let stem = target
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_else(|| file.clone());
        let extension = target
            .extension()
            .map(|extension| format!(".{}", extension.to_string_lossy()))
            .unwrap_or_default();
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_secs())
            .unwrap_or(0);
        target = dir.join(format!("{stem}-{at}{extension}"));
    }
    fs::write(&target, &bytes)
        .map_err(|error| format!("could not write {}: {error}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn a_name_with_separators_keeps_only_its_last_segment() {
        assert_eq!(safe_name("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(
            safe_name(r"C:\Users\me\backup.json").unwrap(),
            "backup.json"
        );
    }

    #[test]
    fn an_empty_name_is_refused_rather_than_written() {
        assert!(safe_name("   ").is_err());
        assert!(safe_name(".hidden").is_err());
    }

    #[test]
    fn an_ordinary_name_is_untouched() {
        assert_eq!(
            safe_name("HardlyTracking-2026-11-19.json").unwrap(),
            "HardlyTracking-2026-11-19.json"
        );
    }
}
