/* ============================================================
   sparkEditor · src-tauri/src/watch.rs

   Filesystem watching for the explorer.

   The renderer already had the whole client half of this — a
   `watch_path` / `unwatch_path` bridge and a `file:changed`
   subscription wired up in App.tsx — but no host command existed,
   so `watchPath` would have thrown and the subscription listened
   for an event nothing ever emitted. The tree therefore showed
   whatever was on disk when a directory was last expanded, and
   never noticed a change made outside the app.

   Events are coalesced over a short window: a single `git checkout`
   or `npm install` produces thousands of raw notifications, and
   forwarding each one would make the renderer re-read directories
   faster than it can paint them.
   ============================================================ */

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::HostError;

/// How long to gather events before emitting. Long enough to collapse a
/// bulk operation, short enough that a single save still feels immediate.
const COALESCE: Duration = Duration::from_millis(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// "created" | "removed" | "modified" | "renamed"
    pub kind: String,
    pub path: String,
    /// Previous path, for a rename the OS reported as a pair.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

struct Watch {
    /// Dropping the watcher stops the OS-level subscription.
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct WatchManager {
    watches: Mutex<HashMap<String, Watch>>,
    next_id: AtomicU64,
}

fn poisoned<T>(_: T) -> HostError {
    HostError::Internal {
        message: "watch manager lock poisoned".into(),
    }
}

fn kind_name(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Remove(_) => Some("removed"),
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => Some("renamed"),
        EventKind::Modify(_) => Some("modified"),
        // Access events fire on every read; forwarding them would make the
        // explorer refresh whenever anything merely opened a file.
        EventKind::Access(_) | EventKind::Any | EventKind::Other => None,
    }
}

/// Turn a batch of raw notify events into the smallest set of changes the
/// renderer needs. The explorer refreshes a whole directory per event, so
/// one change per (kind, path) is all that can matter.
fn coalesce(events: Vec<Event>) -> Vec<FileChange> {
    let mut seen: Vec<FileChange> = Vec::new();
    for event in events {
        let Some(kind) = kind_name(&event.kind) else {
            continue;
        };
        // notify reports a rename as one event carrying both paths.
        let (path, from) = match (event.paths.first(), event.paths.get(1)) {
            (Some(a), Some(b)) => (b.clone(), Some(a.to_string_lossy().to_string())),
            (Some(a), None) => (a.clone(), None),
            _ => continue,
        };
        let path = path.to_string_lossy().to_string();
        if seen
            .iter()
            .any(|c| c.kind == kind && c.path == path && c.from == from)
        {
            continue;
        }
        seen.push(FileChange {
            kind: kind.to_string(),
            path,
            from,
        });
    }
    seen
}

#[tauri::command]
pub fn watch_path(
    app: AppHandle,
    manager: tauri::State<'_, WatchManager>,
    path: String,
) -> Result<String, HostError> {
    let target = std::path::PathBuf::from(&path);
    if !target.exists() {
        return Err(HostError::NotFound { path });
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(tx, Config::default()).map_err(|e| {
        HostError::Internal {
            message: format!("watcher: {e}"),
        }
    })?;
    watcher
        .watch(&target, RecursiveMode::Recursive)
        .map_err(|e| match e.kind {
            notify::ErrorKind::PathNotFound => HostError::NotFound { path: path.clone() },
            notify::ErrorKind::MaxFilesWatch => HostError::Internal {
                message: "the system watch limit was reached (raise fs.inotify.max_user_watches)"
                    .into(),
            },
            _ => HostError::Internal {
                message: format!("watch {path}: {e}"),
            },
        })?;

    let id = format!("watch-{}", manager.next_id.fetch_add(1, Ordering::SeqCst) + 1);
    let stop = Arc::new(AtomicBool::new(false));

    {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut batch: Vec<Event> = Vec::new();
            let mut window_opened: Option<Instant> = None;

            loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                // Wake regularly so a batch still flushes once the source
                // goes quiet, and so `stop` is noticed promptly.
                match rx.recv_timeout(Duration::from_millis(60)) {
                    Ok(Ok(event)) => {
                        batch.push(event);
                        window_opened.get_or_insert_with(Instant::now);
                    }
                    Ok(Err(_)) => {} // a dropped event is not worth tearing down for
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                let due = window_opened.is_some_and(|t| t.elapsed() >= COALESCE);
                if due && !batch.is_empty() {
                    for change in coalesce(std::mem::take(&mut batch)) {
                        let _ = app.emit("file:changed", change);
                    }
                    window_opened = None;
                } else if due {
                    window_opened = None;
                }
            }
        });
    }

    manager.watches.lock().map_err(poisoned)?.insert(
        id.clone(),
        Watch {
            _watcher: watcher,
            stop,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn unwatch_path(
    manager: tauri::State<'_, WatchManager>,
    id: String,
) -> Result<(), HostError> {
    // Unwatching an unknown id is documented as a no-op: callers unwatch
    // during teardown, where racing with an earlier cleanup is normal.
    if let Some(watch) = manager.watches.lock().map_err(poisoned)?.remove(&id) {
        watch.stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Stop every watcher. Called on exit so no thread outlives the app.
pub fn shutdown_all(manager: &WatchManager) {
    if let Ok(mut watches) = manager.watches.lock() {
        for (_, watch) in watches.drain() {
            watch.stop.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RenameMode};
    use std::path::PathBuf;

    fn ev(kind: EventKind, paths: &[&str]) -> Event {
        Event {
            kind,
            paths: paths.iter().map(PathBuf::from).collect(),
            attrs: Default::default(),
        }
    }

    #[test]
    fn access_events_are_dropped() {
        // Otherwise merely reading a file would refresh the explorer.
        assert!(kind_name(&EventKind::Access(notify::event::AccessKind::Read)).is_none());
        assert_eq!(kind_name(&EventKind::Create(CreateKind::File)), Some("created"));
        assert_eq!(
            kind_name(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            Some("renamed")
        );
    }

    #[test]
    fn duplicate_events_collapse_to_one() {
        // A single save can emit several identical modify events.
        let batch = vec![
            ev(EventKind::Modify(ModifyKind::Any), &["/w/a.md"]),
            ev(EventKind::Modify(ModifyKind::Any), &["/w/a.md"]),
            ev(EventKind::Modify(ModifyKind::Any), &["/w/a.md"]),
        ];
        let out = coalesce(batch);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "/w/a.md");
        assert_eq!(out[0].kind, "modified");
    }

    #[test]
    fn distinct_paths_are_all_reported() {
        let batch = vec![
            ev(EventKind::Create(CreateKind::File), &["/w/a.md"]),
            ev(EventKind::Create(CreateKind::File), &["/w/b.md"]),
        ];
        assert_eq!(coalesce(batch).len(), 2);
    }

    #[test]
    fn a_rename_carries_both_paths() {
        let batch = vec![ev(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &["/w/old.md", "/w/new.md"],
        )];
        let out = coalesce(batch);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "renamed");
        assert_eq!(out[0].path, "/w/new.md");
        assert_eq!(out[0].from.as_deref(), Some("/w/old.md"));
    }

    #[test]
    fn access_noise_is_filtered_out_of_a_batch() {
        let batch = vec![
            ev(
                EventKind::Access(notify::event::AccessKind::Read),
                &["/w/a.md"],
            ),
            ev(EventKind::Remove(notify::event::RemoveKind::File), &["/w/a.md"]),
        ];
        let out = coalesce(batch);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "removed");
    }

    /// Exercises the real OS watcher: create a file in a temp dir and
    /// confirm notify reports it through the same filter the command uses.
    #[test]
    fn a_real_file_creation_is_reported() {
        let dir = std::env::temp_dir().join(format!("spark-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");

        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(tx, Config::default()).expect("watcher");
        watcher
            .watch(&dir, RecursiveMode::Recursive)
            .expect("watch");

        // inotify registration is asynchronous; write after a beat or the
        // event can land before the watch is armed.
        std::thread::sleep(Duration::from_millis(150));
        std::fs::write(dir.join("created.txt"), b"hi").expect("write");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut batch = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(e)) => batch.push(e),
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !batch.is_empty() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        drop(watcher);
        let changes = coalesce(batch);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            changes.iter().any(|c| c.path.ends_with("created.txt")),
            "watcher never reported the new file; got {changes:?}"
        );
    }

    #[test]
    fn an_event_with_no_path_is_skipped() {
        assert!(coalesce(vec![ev(EventKind::Create(CreateKind::File), &[])]).is_empty());
    }
}
