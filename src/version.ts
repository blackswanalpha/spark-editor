/* ============================================================
   sparkBook · src/version.ts
   The app version, for display.

   `APP_VERSION` is baked in at build time from package.json. That
   is only what the bundle *believed* it was: if package.json and
   src-tauri/tauri.conf.json ever drift, or a stale dist/ is served,
   it reports the wrong number — which is how "the update worked but
   the version didn't change" hides.

   `useAppVersion()` prefers the version reported by the running
   Tauri binary and falls back to the build-time constant in the
   browser. Prefer it anywhere a user can see the number.
   ============================================================ */
import { useEffect, useState } from "react";
import pkg from "../package.json";
import { getRuntimeVersion } from "@bridge/updater";

/** Build-time version from package.json. Fallback only — see above. */
export const APP_VERSION: string = pkg.version;

/**
 * The version actually running. Starts at the build-time constant and
 * settles on the host-reported value once it resolves, so nothing ever
 * renders blank.
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState(APP_VERSION);

  useEffect(() => {
    let cancelled = false;
    getRuntimeVersion()
      .then((v) => {
        if (!cancelled && v) setVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
