use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum HostError {
    #[error("not found: {path}")]
    NotFound { path: String },
    #[error("permission denied: {path}")]
    PermissionDenied { path: String },
    #[error("not utf-8: {path}")]
    NotUtf8 { path: String },
    #[error("is a directory: {path}")]
    IsADirectory { path: String },
    #[error("already exists: {path}")]
    AlreadyExists { path: String },
    #[error("invalid path: {path}: {reason}")]
    InvalidPath { path: String, reason: String },
    #[error("internal: {message}")]
    Internal { message: String },
}

impl From<std::io::Error> for HostError {
    fn from(e: std::io::Error) -> Self {
        HostError::Internal { message: e.to_string() }
    }
}

#[derive(Serialize, Deserialize)]
pub struct WriteReceipt {
    pub path: String,
    pub bytes: usize,
    pub mtime: String,
    pub device: u64,
    pub inode: u64,
}

#[tauri::command]
fn read_file(path: String) -> Result<String, HostError> {
    std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => HostError::NotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => HostError::PermissionDenied { path: path.clone() },
        std::io::ErrorKind::InvalidData => HostError::NotUtf8 { path: path.clone() },
        _ => HostError::Internal { message: e.to_string() },
    })
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<WriteReceipt, HostError> {
    std::fs::write(&path, &contents)?;
    let meta = std::fs::metadata(&path)?;
    let mtime = meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            let secs = d.as_secs() as i64;
            // basic ISO 8601 UTC
            chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    Ok(WriteReceipt {
        path,
        bytes: contents.len(),
        mtime,
        device: 0,
        inode: 0,
    })
}

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirEntry>, HostError> {
    let mut out = vec![];
    for entry in std::fs::read_dir(&path)? {
        let entry = entry?;
        let meta = entry.metadata().ok();
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_file: meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
            is_dir:  meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub is_file: bool,
    pub is_dir: bool,
}

#[tauri::command]
fn stat(path: String) -> Result<FileStat, HostError> {
    let meta = std::fs::metadata(&path)?;
    Ok(FileStat {
        path: path.clone(),
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime: meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0).map(|dt| dt.to_rfc3339()))
            .unwrap_or_default(),
    })
}

#[derive(Serialize, Deserialize)]
pub struct FileStat {
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, read_dir, stat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
