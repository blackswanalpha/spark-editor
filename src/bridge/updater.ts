/* ============================================================
   sparkEditor · src/bridge/updater.ts
   OTA updater bridge (Tauri plugin-updater).

   Why this file is more than a `check()` call
   ------------------------------------------
   The bug it addresses: the updater reports "installed", the app
   restarts, and comes back on the same version.

   Three guards, cheapest first:

   1. The manifest is not actually newer. If latest.json advertises
      a version <= the one running, installing it changes nothing
      while still reporting success. This happens whenever a release
      is tagged without bumping src-tauri/tauri.conf.json — the
      release is named v0.3.3 but ships, and advertises, 0.3.2.
      (scripts/check-version-sync.mjs stops that at build time; this
      is the client-side half.)

   2. The install cannot be replaced in place. The host reports the
      bundle type the updater itself keys off. Packaged builds
      (.deb, .rpm, AppImage, msi, nsis, .app) all have a working
      installer; an *unpackaged* binary does not, and on Linux the
      plugin would write the download over the running executable
      and report success. Refused before downloading.

   3. It still didn't take. Every install writes a receipt before
      restarting, and `verifyPendingUpdate()` compares the version
      actually running on the next boot against the one promised —
      so a silent failure becomes a reported one instead of a
      mystery.
   ============================================================ */
import { isTauri } from "@bridge/commands";

type ToastFn = (title: string, body?: string) => void;

/** Reported by the Rust host — see src-tauri/src/update_env.rs. */
export interface UpdateEnvironment {
  version: string;
  /** "deb" | "rpm" | "appimage" | "msi" | "nsis" | "app" | "unpackaged" */
  installKind: string;
  canSelfUpdate: boolean;
  blockedReason?: string;
  artifactPath?: string;
  exePath: string;
}

export interface PendingUpdate {
  from: string;
  to: string;
  /** ISO timestamp of when the install completed. */
  at: string;
  installKind: string;
}

const PENDING_KEY = "spark.update.pending";

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
 * Compare two dotted version strings numerically.
 * Returns >0 when `a` is newer, <0 when older, 0 when equal.
 * Pre-release suffixes ("1.2.3-beta.1") sort before their release, as
 * semver requires.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = String(v).trim().replace(/^v/i, "").split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  // Equal cores: a release outranks any pre-release of the same core.
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The version actually running, straight from the compiled binary.
 *
 * `src/version.ts` reads package.json at build time, which is only what
 * the bundle *believed* it was — if package.json and tauri.conf.json ever
 * drift, or the frontend is served from a stale dist, it lies. The Tauri
 * app API reports what the host binary really is.
 */
export async function getRuntimeVersion(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}

/** Ask the host how this copy was installed and whether OTA can apply. */
export async function getUpdateEnvironment(): Promise<UpdateEnvironment | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<UpdateEnvironment>("update_environment");
  } catch {
    return null;
  }
}

/* ---------- Pending-update receipt ---------- */

function readPending(): PendingUpdate | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingUpdate>;
    if (typeof parsed?.from !== "string" || typeof parsed?.to !== "string") return null;
    return {
      from: parsed.from,
      to: parsed.to,
      at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(),
      installKind: typeof parsed.installKind === "string" ? parsed.installKind : "unknown",
    };
  } catch {
    return null;
  }
}

function writePending(p: PendingUpdate | null): void {
  try {
    if (p === null) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — verification degrades to "no receipt" */
  }
}

export type VerifyResult =
  | { status: "none" }
  | { status: "applied"; version: string }
  | { status: "not-applied"; expected: string; actual: string; installKind: string };

/**
 * Compare the running version against the last install receipt.
 *
 * This is what turns "update said success but nothing changed" from an
 * invisible failure into a reported one. Call it on boot.
 */
export async function verifyPendingUpdate(
  /** Injectable for tests; defaults to the running binary's version. */
  readVersion: () => Promise<string | null> = getRuntimeVersion,
): Promise<VerifyResult> {
  const pending = readPending();
  if (!pending) return { status: "none" };

  // No readable version means no verdict — staying silent beats claiming
  // an update failed when we simply cannot tell.
  const actual = await readVersion();
  if (actual == null) return { status: "none" };

  // Reaching the promised version — or anything newer — means it worked.
  if (compareVersions(actual, pending.to) >= 0) {
    writePending(null);
    return { status: "applied", version: actual };
  }

  // Still on the old version: the install did not take. Clear the receipt
  // so this is reported once, not on every launch from here on.
  writePending(null);
  return {
    status: "not-applied",
    expected: pending.to,
    actual,
    installKind: pending.installKind,
  };
}

/* ---------- Check + install ---------- */

export interface UpdateOptions {
  silent?: boolean;
  onInfo?: ToastFn;
  onSuccess?: ToastFn;
  onError?: ToastFn;
  /** Skip the restart (used by tests and by callers that batch restarts). */
  noRestart?: boolean;
}

/**
 * Check for an OTA update; download, install and restart when one exists.
 *
 * Returns true only when an update was installed. A blocked install
 * medium returns false with an explanatory toast — never a silent
 * success.
 */
export async function checkForUpdates(opts?: UpdateOptions): Promise<boolean> {
  if (!isTauri) return false;

  let check: typeof import("@tauri-apps/plugin-updater").check;
  try {
    ({ check } = await import("@tauri-apps/plugin-updater"));
  } catch {
    opts?.onError?.("Updater unavailable", "Plugin not loaded");
    return false;
  }

  const env = await getUpdateEnvironment();
  const currentVersion = env?.version ?? (await getRuntimeVersion()) ?? "unknown";

  try {
    const update = await check();
    if (!update) {
      if (!opts?.silent) opts?.onInfo?.("No updates", `sparkEditor ${currentVersion} is up to date`);
      return false;
    }

    // Guard against a manifest that advertises a version we already run
    // (or an older one). Installing it would "succeed" and change nothing —
    // precisely the phantom-update symptom.
    if (currentVersion !== "unknown" && compareVersions(update.version, currentVersion) <= 0) {
      if (!opts?.silent) {
        opts?.onInfo?.(
          "No updates",
          `The release manifest offers ${update.version}, which is not newer than the installed ${currentVersion}.`,
        );
      }
      return false;
    }

    // Refuse before downloading when this install cannot be replaced in
    // place. Downloading first would waste the transfer and end in a
    // success message with no effect.
    if (env && !env.canSelfUpdate) {
      opts?.onError?.(
        `Update ${update.version} cannot be installed automatically`,
        env.blockedReason ??
          `This ${env.installKind} install cannot be updated in place. Reinstall manually to get ${update.version}.`,
      );
      return false;
    }

    opts?.onInfo?.(
      `Update available — ${update.version}`,
      update.body ? String(update.body).slice(0, 200) : "Downloading…",
    );

    let downloaded = 0;
    let contentLength = 0;
    await update.downloadAndInstall((e) => {
      switch (e.event) {
        case "Started":
          contentLength = e.data.contentLength ?? 0;
          opts?.onInfo?.(
            "Downloading update…",
            contentLength ? `${(contentLength / 1e6).toFixed(1)} MB` : undefined,
          );
          break;
        case "Progress":
          downloaded += e.data.chunkLength ?? 0;
          break;
        case "Finished":
          opts?.onInfo?.(
            "Installing update…",
            downloaded ? `${(downloaded / 1e6).toFixed(1)} MB downloaded` : undefined,
          );
          break;
      }
    });

    // Write the receipt BEFORE restarting. If the restart re-runs the old
    // binary, the next boot has the evidence to say so.
    writePending({
      from: currentVersion,
      to: update.version,
      at: new Date().toISOString(),
      installKind: env?.installKind ?? "unknown",
    });

    opts?.onSuccess?.("Update installed", `v${update.version} — restarting…`);

    if (!opts?.noRestart) {
      // Let the toast paint, then restart through the host so the
      // AppImage indirection is handled.
      setTimeout(() => {
        void restartApp();
      }, 1200);
    }
    return true;
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message ?? String(err);
    switch (classifyUpdaterError(msg)) {
      case "no-release":
        if (!opts?.silent) opts?.onInfo?.("No updates", "No release published yet");
        return false;
      case "no-platform":
        if (!opts?.silent) opts?.onInfo?.("No updates", "No update available for this platform yet");
        return false;
      case "error":
        opts?.onError?.("Update check failed", msg);
        return false;
    }
  }
}

/**
 * Restart the app through the host, falling back to the process plugin.
 * Both resolve the binary the same way (`$APPIMAGE` before `current_exe`),
 * so an updated AppImage is re-executed rather than the mount it replaced.
 */
export async function restartApp(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("restart_app");
    return;
  } catch {
    /* fall through to the plugin */
  }
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    /* nothing left to try — the user restarts manually */
  }
}

/**
 * Boot-time updater work: report on the previous install first, then do
 * a quiet check for a new one.
 */
export function checkForUpdatesOnBoot(toast: {
  info: ToastFn;
  success: ToastFn;
  error: ToastFn;
}): () => void {
  let cancelled = false;

  const verifyTimer = window.setTimeout(() => {
    void verifyPendingUpdate()
      .then((result) => {
        if (cancelled) return;
        if (result.status === "applied") {
          toast.success("Updated", `Now running v${result.version}`);
        } else if (result.status === "not-applied") {
          toast.error(
            `Update to ${result.expected} did not apply`,
            `Still running ${result.actual}. ${describeFailedInstall(result.installKind)}`,
          );
        }
      })
      .catch(() => {});
  }, 900);

  const checkTimer = window.setTimeout(() => {
    if (cancelled) return;
    void checkForUpdates({
      silent: true,
      onInfo: toast.info,
      onSuccess: toast.success,
      onError: toast.error,
    }).catch(() => {});
  }, 4000);

  return () => {
    cancelled = true;
    window.clearTimeout(verifyTimer);
    window.clearTimeout(checkTimer);
  };
}

export function describeFailedInstall(installKind: string): string {
  switch (installKind) {
    case "deb":
      return "The package install (dpkg) did not complete — it needs pkexec or sudo to elevate. Try `sudo apt install` on the downloaded .deb.";
    case "rpm":
      return "The package install (rpm) did not complete — it needs pkexec or sudo to elevate. Install the downloaded .rpm manually.";
    case "appimage":
      return "The AppImage was not replaced. Check that its directory is writable, then retry.";
    case "msi":
    case "nsis":
      return "The Windows installer did not complete. Run it manually from the release page.";
    case "app":
      return "The application bundle was not replaced. Check that it is not running from a read-only volume.";
    case "unpackaged":
      return "This build did not come from an installer, so there is nothing for the updater to replace. Install the packaged build to receive updates.";
    default:
      return "Reinstall manually to pick up the new version.";
  }
}
