/* sparkEditor — OTA updater bridge (Tauri plugin-updater) */
import { isTauri } from "@bridge/commands";

type ToastFn = (title: string, body?: string) => void;

/**
 * Classify an updater error so expected conditions are never surfaced
 * as failures. Tauri's updater throws a few well-known shapes:
 *
 *  - "no-release"  — the endpoint 404s (no release published yet).
 *  - "no-platform" — latest.json exists but has no entry for this
 *    platform, e.g. a linux client hitting a manifest that only
 *    publishes darwin/windows artifacts:
 *      `None of the fallback platforms `["linux-x86_64"]` were found
 *       in the response `platforms` object`
 *  - "error"       — anything else (network, signature, …).
 */
export function classifyUpdaterError(msg: string): "no-release" | "no-platform" | "error" {
  const m = msg.toLowerCase();
  if (
    m.includes("fallback platforms") ||
    m.includes("platforms` object") ||
    m.includes("platforms object") ||
    m.includes("were found in the response") ||
    /["'`]?(linux|darwin|windows)-[a-z0-9_]+["'`]?\s+(was|were)\s+not/.test(m)
  ) {
    return "no-platform";
  }
  if (m.includes("404") || m.includes("not found")) return "no-release";
  return "error";
}

/**
 * Check for OTA update via Tauri updater.
 * - No-op in browser (Vite) dev where Tauri is not present.
 * - If an update is available, downloads + installs, then prompts restart.
 * Returns true if update installed, false otherwise.
 */
export async function checkForUpdates(opts?: {
  silent?: boolean;
  onInfo?: ToastFn;
  onSuccess?: ToastFn;
  onError?: ToastFn;
}): Promise<boolean> {
  if (!isTauri) return false;

  // Dynamic import so Vite browser build doesn't bundle tauri-only code eagerly
  let check: any;
  let relaunch: any;
  try {
    ({ check } = await import("@tauri-apps/plugin-updater"));
    ({ relaunch } = await import("@tauri-apps/plugin-process"));
  } catch {
    opts?.onError?.("Updater unavailable", "Plugin not loaded");
    return false;
  }

  try {
    const update = await check();
    if (!update) {
      if (!opts?.silent) opts?.onInfo?.("No updates", "sparkEditor is up to date");
      return false;
    }

    opts?.onInfo?.(
      `Update available — ${update.version}`,
      update.body ? String(update.body).slice(0, 200) : "Downloading…",
    );

    let downloaded = 0;
    let contentLength = 0;
    await update.downloadAndInstall((e: any) => {
      switch (e.event) {
        case "Started":
          contentLength = e.data.contentLength ?? 0;
          opts?.onInfo?.("Downloading update…", contentLength ? `${(contentLength / 1e6).toFixed(1)} MB` : undefined);
          break;
        case "Progress":
          downloaded += e.data.chunkLength ?? 0;
          break;
        case "Finished":
          break;
      }
    });

    opts?.onSuccess?.("Update installed", `v${update.version} — restarting…`);

    // Give toast a moment to display, then restart
    setTimeout(async () => {
      try {
        await relaunch();
      } catch {}
    }, 1200);

    return true;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    switch (classifyUpdaterError(msg)) {
      case "no-release":
        // 404 on latest.json is normal when no release exists yet
        if (!opts?.silent) opts?.onInfo?.("No updates", "No release published yet");
        return false;
      case "no-platform": {
        // Platform missing from latest.json (e.g. linux artifact not in release).
        if (!opts?.silent) opts?.onInfo?.("No updates", "No update available for this platform yet");
        return false;
      }
      case "error":
        opts?.onError?.("Update check failed", msg);
        return false;
    }
  }
}

/** Fire-and-forget background check (silent) — call on app boot. */
export function checkForUpdatesOnBoot(toast: {
  info: ToastFn;
  success: ToastFn;
  error: ToastFn;
}) {
  // Delay a bit so window paint isn't blocked
  setTimeout(() => {
    checkForUpdates({ silent: true, onInfo: toast.info, onSuccess: toast.success, onError: toast.error }).catch(() => {});
  }, 4000);
}
