use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri_plugin_store::StoreExt;
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
        HostError::Internal {
            message: e.to_string(),
        }
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
        _ => HostError::Internal {
            message: e.to_string(),
        },
    })
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<WriteReceipt, HostError> {
    std::fs::write(&path, &contents)?;
    let meta = std::fs::metadata(&path)?;
    let mtime = meta
        .modified()
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
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| {
                chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            })
            .unwrap_or_default(),
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: String,
}

#[tauri::command]
fn create_file(path: String, contents: Option<String>) -> Result<FileStat, HostError> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => HostError::AlreadyExists { path: path.clone() },
            std::io::ErrorKind::NotFound => HostError::NotFound { path: path.clone() },
            std::io::ErrorKind::PermissionDenied => {
                HostError::PermissionDenied { path: path.clone() }
            }
            std::io::ErrorKind::IsADirectory => HostError::IsADirectory { path: path.clone() },
            _ => HostError::Internal {
                message: e.to_string(),
            },
        })?;
    if let Some(contents) = contents.as_deref() {
        std::io::Write::write_all(&mut &file, contents.as_bytes()).map_err(|e| {
            HostError::Internal {
                message: e.to_string(),
            }
        })?;
    }
    drop(file);
    let meta = std::fs::metadata(&path)?;
    Ok(FileStat {
        path,
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| {
                chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            })
            .unwrap_or_default(),
    })
}

#[tauri::command]
fn mkdir(path: String) -> Result<(), HostError> {
    match std::fs::create_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) => match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                Err(HostError::PermissionDenied { path: path.clone() })
            }
            _ => Err(HostError::Internal {
                message: e.to_string(),
            }),
        },
    }
}

#[tauri::command]
fn rename(from: String, to: String) -> Result<(), HostError> {
    if std::fs::metadata(&to).is_ok() {
        return Err(HostError::AlreadyExists { path: to });
    }
    if let Some(parent) = std::path::Path::new(&to).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)?;
    Ok(())
}

#[tauri::command]
fn delete(path: String) -> Result<(), HostError> {
    let meta = std::fs::metadata(&path)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path)?;
    } else {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

#[tauri::command]
fn copy(from: String, to: String) -> Result<(), HostError> {
    if std::fs::metadata(&to).is_ok() {
        return Err(HostError::AlreadyExists { path: to });
    }
    if let Some(parent) = std::path::Path::new(&to).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let meta = std::fs::metadata(&from)?;
    if meta.is_dir() {
        copy_dir_recursive(std::path::Path::new(&from), std::path::Path::new(&to))?;
    } else {
        std::fs::copy(&from, &to)?;
    }
    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn open_in_terminal(cwd: String) -> Result<(), HostError> {
    use std::process::Command;
    let (shell, args) = if cfg!(target_os = "macos") {
        // `open -a Terminal <cwd>` opens Terminal.app at `cwd`.
        ("open".to_string(), vec!["-a".to_string(), "Terminal".to_string(), cwd.clone()])
    } else if cfg!(target_os = "windows") {
        // `cmd /K cd /d <cwd>` opens a new console window rooted at `cwd`.
        ("cmd".to_string(), vec!["/C".to_string(), "start".to_string(), "cmd".to_string(), "/K".to_string(), format!("cd /d {}", cwd)])
    } else {
        // Linux / *BSD: try common terminal emulators; fall back to x-terminal-emulator.
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "alacritty", "xterm"] {
            if Command::new("which").arg(term).output().map(|o| o.status.success()).unwrap_or(false) {
                let arg = match term {
                    "gnome-terminal" => format!("--working-directory={}", cwd),
                    "konsole" => format!("--workdir {}", cwd),
                    "alacritty" => format!("--working-directory {}", cwd),
                    _ => cwd.clone(),
                };
                return Command::new(term)
                    .args([arg.as_str()])
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| HostError::Internal { message: e.to_string() });
            }
        }
        return Err(HostError::Internal { message: "No terminal emulator found".to_string() });
    };
    Command::new(&shell)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| HostError::Internal { message: e.to_string() })
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), HostError> {
    use std::process::Command;
    if cfg!(target_os = "macos") {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| HostError::Internal { message: e.to_string() })
    } else if cfg!(target_os = "windows") {
        Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map(|_| ())
            .map_err(|e| HostError::Internal { message: e.to_string() })
    } else {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string());
        Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map(|_| ())
            .map_err(|e| HostError::Internal { message: e.to_string() })
    }
}

#[tauri::command]
fn open_with_os(path: String) -> Result<(), HostError> {
    use std::process::Command;
    if cfg!(target_os = "macos") {
        Command::new("open").arg(&path).spawn().map(|_| ()).map_err(|e| HostError::Internal { message: e.to_string() })
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", &path]).spawn().map(|_| ()).map_err(|e| HostError::Internal { message: e.to_string() })
    } else {
        Command::new("xdg-open").arg(&path).spawn().map(|_| ()).map_err(|e| HostError::Internal { message: e.to_string() })
    }
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, HostError> {
    let bytes = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => HostError::NotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => HostError::PermissionDenied { path: path.clone() },
        _ => HostError::Internal {
            message: e.to_string(),
        },
    })?;
    // base64 encode without extra deps: use base64 crate if available, else manual
    // Use `base64` via `tauri`'s dependency if present; fallback to manual.
    // We add base64 crate as optional; implement simple encode.
    Ok(encode_base64(&bytes))
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i] as u32;
        let b1 = if i + 1 < input.len() {
            input[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < input.len() {
            input[i + 2] as u32
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if i + 1 < input.len() {
            TABLE[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if i + 2 < input.len() {
            TABLE[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
        i += 3;
    }
    out
}

const RECENTS_STORE: &str = "recents.json";
const RECENTS_KEY: &str = "paths";
const RECENTS_MAX: usize = 25;

fn recents_load(app: &tauri::AppHandle) -> Result<Vec<String>, HostError> {
    let store = app.store(RECENTS_STORE).map_err(|e| HostError::Internal {
        message: e.to_string(),
    })?;
    let list = store
        .get(RECENTS_KEY)
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();
    Ok(list)
}

fn recents_save(app: &tauri::AppHandle, list: &[String]) -> Result<(), HostError> {
    let store = app.store(RECENTS_STORE).map_err(|e| HostError::Internal {
        message: e.to_string(),
    })?;
    store.set(RECENTS_KEY, json!(list));
    store.save().map_err(|e| HostError::Internal {
        message: e.to_string(),
    })?;
    Ok(())
}

#[tauri::command]
fn recents_get(app: tauri::AppHandle) -> Result<Vec<String>, HostError> {
    recents_load(&app)
}

#[tauri::command]
fn recents_add(app: tauri::AppHandle, path: String) -> Result<Vec<String>, HostError> {
    let mut list = recents_load(&app)?;
    if path.is_empty() {
        return Ok(list);
    }
    list.retain(|p| p != &path);
    list.insert(0, path);
    if list.len() > RECENTS_MAX {
        list.truncate(RECENTS_MAX);
    }
    recents_save(&app, &list)?;
    Ok(list)
}

#[tauri::command]
fn recents_clear(app: tauri::AppHandle) -> Result<(), HostError> {
    recents_save(&app, &[])?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_file,
            read_file_base64,
            write_file,
            read_dir,
            stat,
            create_file,
            mkdir,
            rename,
            delete,
            copy,
            open_in_terminal,
            reveal_in_folder,
            open_with_os,
            recents_get,
            recents_add,
            recents_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
