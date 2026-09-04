/* ============================================================
   sparkBook · src/bridge/clipboard.ts

   One clipboard for the whole app, with the fallbacks the desktop
   build actually needs.

   `navigator.clipboard` is not a reliable path inside a Tauri
   webview: WebKitGTK (the Linux backend) ships `writeText` but not
   `readText`, and both are gated on a user-gesture heuristic that a
   synthesised keydown handler does not always satisfy. The Tauri
   clipboard-manager plugin talks to the OS directly and has neither
   problem, so it goes first whenever it is there.

   Every entry point returns a boolean / string rather than throwing:
   a failed copy should degrade to "nothing happened", never to an
   unhandled rejection in a keydown handler.
   ============================================================ */
import { isTauri } from "@bridge/commands";

type ClipboardPlugin = {
  writeText: (t: string) => Promise<void>;
  readText: () => Promise<string | null>;
};

/* The plugin is imported lazily and remembered: pulling it in on module
   load would drag the Tauri IPC glue into the browser build, where the
   whole module has to keep working. */
let pluginPromise: Promise<ClipboardPlugin | null> | null = null;

function plugin(): Promise<ClipboardPlugin | null> {
  if (!isTauri) return Promise.resolve(null);
  pluginPromise ??= import("@tauri-apps/plugin-clipboard-manager")
    .then((m) => ({ writeText: m.writeText, readText: m.readText }) as ClipboardPlugin)
    .catch(() => null);
  return pluginPromise;
}

/** Copy `text`. Returns whether it reached a clipboard. */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return false;

  const p = await plugin();
  if (p) {
    try {
      await p.writeText(text);
      return true;
    } catch {
      /* fall through to the web APIs */
    }
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }

  return legacyCopy(text);
}

/** Read the clipboard, or "" when it is empty or unreadable. */
export async function readClipboardText(): Promise<string> {
  const p = await plugin();
  if (p) {
    try {
      return (await p.readText()) ?? "";
    } catch {
      /* fall through */
    }
  }

  try {
    if (navigator.clipboard?.readText) return (await navigator.clipboard.readText()) ?? "";
  } catch {
    /* no permission, or an engine without readText */
  }

  return "";
}

/**
 * `document.execCommand("copy")` against a detached textarea.
 *
 * Deprecated, and the only thing that works in an insecure context or an
 * engine without the async clipboard API — which is exactly where the
 * calls above have already failed.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
  document.body.appendChild(ta);
  const previous = document.activeElement as HTMLElement | null;
  try {
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    // Taking focus away from the terminal would send the next keystroke
    // nowhere, so put it back where it was.
    previous?.focus?.({ preventScroll: true });
  }
}
