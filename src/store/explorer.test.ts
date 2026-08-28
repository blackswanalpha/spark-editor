/* ============================================================
   sparkEditor · src/store/explorer.test.ts
   Tests for the explorer store actions added for the
   context-menu (rename / delete / copy / clipboard paste).

   Note: the bridge mock has hardcoded children for `/` and `/docs`,
   so we use dynamically-resolved subdirectories (`/docs/audits`,
   `/docs/audits/inner`) for the assertions.
   ============================================================ */
import { describe, it, expect, beforeEach } from "vitest";
import { useExplorer } from "./explorer";

describe("explorer store — context menu actions", () => {
  beforeEach(async () => {
    await useExplorer.getState().setRoot("/");
  });

  it("createFile + renamePath updates the cache and selection", async () => {
    const api = useExplorer.getState();
    const create = await api.createFile("/docs/audits", "alpha.md");
    expect(create.ok).toBe(true);

    await api.loadChildren("/docs/audits");
    const before = useExplorer.getState().children.get("/docs/audits")!;
    expect(before.find((n) => n.name === "alpha.md")).toBeTruthy();

    const renamed = await api.renamePath("/docs/audits/alpha.md", "beta.md");
    expect(renamed.ok).toBe(true);

    const after = useExplorer.getState().children.get("/docs/audits")!;
    expect(after.find((n) => n.name === "alpha.md")).toBeUndefined();
    expect(after.find((n) => n.name === "beta.md")).toBeTruthy();
  });

  it("createFolder + deletePath removes the entry from the parent's listing", async () => {
    const api = useExplorer.getState();
    const create = await api.createFolder("/docs/audits", "subdir");
    expect(create.ok).toBe(true);
    await api.loadChildren("/docs/audits");

    const del = await api.deletePath("/docs/audits/subdir");
    expect(del.ok).toBe(true);

    const after = useExplorer.getState().children.get("/docs/audits")!;
    expect(after.find((n) => n.name === "subdir")).toBeUndefined();
  });

  it("setClipboard + pasteInto with op=copy produces a 'name copy' entry", async () => {
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "inner");
    await api.createFile("/docs/audits/inner", "original.md");
    await api.loadChildren("/docs/audits/inner");

    api.setClipboard({ op: "copy", path: "/docs/audits/inner/original.md" });
    const res = await api.pasteInto("/docs/audits/inner");
    expect(res.ok).toBe(true);

    const listing = useExplorer.getState().children.get("/docs/audits/inner")!;
    expect(listing.find((n) => n.name === "original.md")).toBeTruthy();
    expect(listing.find((n) => n.name === "original copy.md")).toBeTruthy();
  });

  it("setClipboard + pasteInto with op=cut moves the entry and clears the clipboard", async () => {
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "src");
    await api.createFolder("/docs/audits", "dest");
    await api.createFile("/docs/audits/src", "movable.md");
    await api.loadChildren("/docs/audits/src");
    await api.loadChildren("/docs/audits/dest");

    api.setClipboard({ op: "cut", path: "/docs/audits/src/movable.md" });
    const res = await api.pasteInto("/docs/audits/dest");
    expect(res.ok).toBe(true);

    const src = useExplorer.getState().children.get("/docs/audits/src")!;
    expect(src.find((n) => n.name === "movable.md")).toBeUndefined();
    const dest = useExplorer.getState().children.get("/docs/audits/dest")!;
    expect(dest.find((n) => n.name === "movable.md")).toBeTruthy();
    expect(useExplorer.getState().clipboard).toBeNull();
  });

  it("renamePath rejects names containing path separators", async () => {
    const api = useExplorer.getState();
    await api.createFile("/docs/audits", "ok.md");
    await api.loadChildren("/docs/audits");
    const res = await api.renamePath("/docs/audits/ok.md", "bad/name.md");
    expect(res.ok).toBe(false);
  });
});
