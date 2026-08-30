/* ============================================================
   sparkEditor · src-tauri/src/update_env.rs

   What the renderer needs to know before it offers an OTA update:
   how this copy was installed, and whether an in-place update can
   actually take effect.

   The authority is `tauri::utils::platform::bundle_type()` — a
   string the bundler patches into the binary. It is the *same*
   value tauri-plugin-updater reads to choose an installer, so this
   module and the plugin can never disagree:

     Deb / Rpm   -> dpkg -i / rpm -U, elevated through pkexec or
                    sudo. Works.
     AppImage    -> rewrites the file named by $APPIMAGE (the plugin
                    overrides its executable_path with it). Works,
                    provided that file is writable.
     Msi / Nsis  -> runs the installer. Works.
     App (macOS) -> replaces the bundle. Works.
     None        -> the binary was NOT produced by the bundler (a
                    `cargo build`, `tauri dev`, or a binary copied
                    out of a package). The plugin's Linux match arm
                    falls through to the AppImage path and writes
                    the downloaded bytes over current_exe(). That is
                    the case that reports success and leaves the
                    installed version unchanged, so it is refused
                    here before anything is downloaded.
   ============================================================ */

use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;
use tauri::utils::platform::{bundle_type, current_exe};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEnvironment {
    /// The version compiled into this binary. Authoritative — unlike
    /// package.json, which is only what the frontend bundle believed.
    pub version: String,
    /// "deb" | "rpm" | "appimage" | "msi" | "nsis" | "app" | "unpackaged"
    pub install_kind: String,
    /// Whether tauri-plugin-updater can replace this install in place.
    pub can_self_update: bool,
    /// Human-readable reason when `can_self_update` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    /// The artifact the updater would replace, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    /// Path of the running executable.
    pub exe_path: String,
}

fn kind_name(bundle: Option<&BundleType>) -> &'static str {
    match bundle {
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Rpm) => "rpm",
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::Msi) => "msi",
        Some(BundleType::Nsis) => "nsis",
        Some(BundleType::App) => "app",
        Some(_) => "other",
        None => "unpackaged",
    }
}

pub fn detect(version: &str) -> UpdateEnvironment {
    let exe = current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let bundle = bundle_type();
    let kind = kind_name(bundle.as_ref()).to_string();

    match bundle {
        // The AppImage installer rewrites $APPIMAGE in place, so the file
        // has to be writable. A read-only mount or a root-owned directory
        // is the one way this bundle type can silently fail to stick.
        Some(BundleType::AppImage) => {
            let appimage = std::env::var_os("APPIMAGE").map(|p| p.to_string_lossy().to_string());
            match appimage {
                Some(path) => {
                    let writable = std::path::Path::new(&path)
                        .parent()
                        .map(is_writable_dir)
                        .unwrap_or(false);
                    UpdateEnvironment {
                        version: version.to_string(),
                        install_kind: kind,
                        can_self_update: writable,
                        blocked_reason: if writable {
                            None
                        } else {
                            Some(format!(
                                "{path} is in a directory this app cannot write to, so an update \
                                 cannot replace it. Move sparkEditor somewhere writable and retry."
                            ))
                        },
                        artifact_path: Some(path),
                        exe_path: exe,
                    }
                }
                None => UpdateEnvironment {
                    version: version.to_string(),
                    install_kind: kind,
                    can_self_update: false,
                    blocked_reason: Some(
                        "This build is marked as an AppImage but $APPIMAGE is not set, so the \
                         updater would overwrite the running executable instead of the image. \
                         Reinstall from the AppImage to update."
                            .into(),
                    ),
                    artifact_path: None,
                    exe_path: exe,
                },
            }
        }

        // Everything the bundler produced has a working installer path.
        Some(_) => UpdateEnvironment {
            version: version.to_string(),
            install_kind: kind,
            can_self_update: true,
            blocked_reason: None,
            artifact_path: Some(exe.clone()),
            exe_path: exe,
        },

        // No bundle marker: not a packaged build. On Linux the plugin
        // would fall through to the AppImage branch and write the update
        // over current_exe() — reporting success while the installed copy
        // stays exactly as it was.
        None => UpdateEnvironment {
            version: version.to_string(),
            install_kind: kind,
            can_self_update: false,
            blocked_reason: Some(format!(
                "This build was not produced by the Tauri bundler ({exe}), so there is no \
                 installer to run — an update would report success without changing anything. \
                 Install the .deb, .rpm or AppImage to receive updates."
            )),
            artifact_path: None,
            exe_path: exe,
        },
    }
}

fn is_writable_dir(dir: &std::path::Path) -> bool {
    // Probing with a real create is the only portable answer: permission
    // bits alone miss read-only mounts and ACLs.
    let probe = dir.join(format!(".spark-write-probe-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[tauri::command]
pub fn update_environment(app: tauri::AppHandle) -> UpdateEnvironment {
    detect(&app.package_info().version.to_string())
}

/// Restart the app.
///
/// Delegates to `tauri::process::restart`, which resolves the binary via
/// `current_binary()` — that already prefers `$APPIMAGE` over
/// `current_exe()`, so an updated AppImage is re-executed rather than the
/// squashfs mount of the image it replaced.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) -> Result<(), crate::HostError> {
    tauri::process::restart(&app.env());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unbundled_build_is_never_self_updatable() {
        // Under `cargo test` the bundler never patched __TAURI_BUNDLE_TYPE,
        // so this exercises the real "no installer" branch — the one that
        // would otherwise report a successful update and change nothing.
        let env = detect("9.9.9");
        assert_eq!(env.version, "9.9.9");
        assert_eq!(env.install_kind, "unpackaged");
        assert!(!env.can_self_update);
        assert!(env.blocked_reason.is_some());
        assert!(env.artifact_path.is_none());
    }

    #[test]
    fn kind_names_cover_every_bundle_type() {
        assert_eq!(kind_name(Some(&BundleType::Deb)), "deb");
        assert_eq!(kind_name(Some(&BundleType::Rpm)), "rpm");
        assert_eq!(kind_name(Some(&BundleType::AppImage)), "appimage");
        assert_eq!(kind_name(Some(&BundleType::Msi)), "msi");
        assert_eq!(kind_name(Some(&BundleType::Nsis)), "nsis");
        assert_eq!(kind_name(Some(&BundleType::App)), "app");
        assert_eq!(kind_name(None), "unpackaged");
    }

    #[test]
    fn writable_probe_detects_a_real_directory() {
        assert!(is_writable_dir(&std::env::temp_dir()));
        assert!(!is_writable_dir(std::path::Path::new(
            "/definitely/not/a/real/dir"
        )));
    }
}
