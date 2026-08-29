/* ============================================================
   sparkEditor · src/shell/firstRun.ts
   First-run ("has the user seen the welcome wizard?") flag.
   Mirrors the designlab contract (labs/onboarding.html): the
   flag lives in localStorage — the renderer-side analogue of
   the host's state.json first-run defaults (docs/reference/
   app-state.md, boot behaviour step 2).
   ============================================================ */

const FLAG_KEY = "spark.onboarded";

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false; // storage unavailable — treat every run as first run
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(FLAG_KEY, "1");
  } catch {}
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(FLAG_KEY);
  } catch {}
}

/**
 * Decision for showing the welcome wizard on boot: first run and
 * the user has nothing to come back to (no recents, no session).
 * Users who already have files on screen are never interrupted.
 */
export function shouldShowWelcome(opts: { recentsCount: number; docsOpen: number }): boolean {
  if (isOnboarded()) return false;
  return opts.recentsCount === 0 && opts.docsOpen === 0;
}
