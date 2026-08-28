/* ============================================================
   sparkEditor · src/version.ts
   Single source of truth for the app version in the renderer.
   Mirrors package.json / src-tauri/tauri.conf.json.
   ============================================================ */
import pkg from "../package.json";

export const APP_VERSION: string = pkg.version;
