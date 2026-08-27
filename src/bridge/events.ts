/* ============================================================
   sparkEditor · src/bridge/events.ts
   Typed wrappers around Tauri's listen().
   ============================================================ */
import { listen as tListen, type UnlistenFn } from "@tauri-apps/api/event";

export async function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  try {
    return await tListen<T>(event, (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}
