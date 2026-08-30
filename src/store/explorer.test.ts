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

describe("explorer store — copy/paste correctness", () => {
  beforeEach(async () => {
    await useExplorer.getState().setRoot("/");
  });

  it("pasting a copy into a different directory keeps the original name", async () => {
    // Previously every copy was suffixed " copy", so pasting into an empty
    // folder produced "notes copy.md" even with no collision.
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "src");
    await api.createFolder("/docs/audits", "dst");
    await api.createFile("/docs/audits/src", "notes.md");
    await api.loadChildren("/docs/audits/dst");

    api.setClipboard({ op: "copy", path: "/docs/audits/src/notes.md" });
    const res = await useExplorer.getState().pasteInto("/docs/audits/dst");
    expect(res.ok).toBe(true);

    await useExplorer.getState().loadChildren("/docs/audits/dst");
    const names = (useExplorer.getState().children.get("/docs/audits/dst") ?? []).map((n) => n.name);
    expect(names).toContain("notes.md");
    expect(names).not.toContain("notes copy.md");
  });

  it("falls back to 'name copy' only on a real collision", async () => {
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "coll");
    await api.createFile("/docs/audits/coll", "dup.md");
    await api.loadChildren("/docs/audits/coll");

    api.setClipboard({ op: "copy", path: "/docs/audits/coll/dup.md" });
    const res = await useExplorer.getState().pasteInto("/docs/audits/coll");
    expect(res.ok).toBe(true);

    await useExplorer.getState().loadChildren("/docs/audits/coll");
    const names = (useExplorer.getState().children.get("/docs/audits/coll") ?? []).map((n) => n.name);
    expect(names).toContain("dup.md");
    expect(names).toContain("dup copy.md");
  });

  it("a folder copied across directories stays a folder in the cache", async () => {
    // copyTo used to look the source up in the DESTINATION listing, find
    // nothing, and default isDir:false — the copy rendered as a file.
    const api = useExplorer.getState();
    await api.createFolder("/docs/audits", "from");
    await api.createFolder("/docs/audits", "into");
    await api.createFolder("/docs/audits/from", "payload");
    await api.loadChildren("/docs/audits/from");
    await api.loadChildren("/docs/audits/into");

    const res = await useExplorer
      .getState()
      .copyTo("/docs/audits/from/payload", "/docs/audits/into/payload");
    expect(res.ok).toBe(true);

    const entry = (useExplorer.getState().children.get("/docs/audits/into") ?? []).find(
      (n) => n.name === "payload",
    );
    expect(entry).toBeDefined();
    expect(entry!.isDir).toBe(true);
    expect(entry!.isFile).toBe(false);
  });
});

describe("explorer store — navigation and loading state", () => {
  beforeEach(async () => {
    await useExplorer.getState().setRoot("/");
  });

  it("goUp keeps a selection that is still inside the new root", async () => {
    await useExplorer.getState().setRoot("/docs/audits");
    useExplorer.getState().setSelected("/docs/audits");
    await useExplorer.getState().goUp();
    expect(useExplorer.getState().root).toBe("/docs");
    expect(useExplorer.getState().selectedPath).toBe("/docs/audits");
  });

  it("goUp drops a selection that falls outside the new root", async () => {
    await useExplorer.getState().setRoot("/docs/audits");
    useExplorer.getState().setSelected("/elsewhere/file.md");
    await useExplorer.getState().goUp();
    expect(useExplorer.getState().selectedPath).toBeNull();
  });

  it("leaves no path stuck in the loading set after a load", async () => {
    // A stale-generation result used to return early without clearing the
    // flag, leaving that row spinning forever.
    await useExplorer.getState().loadChildren("/docs/audits");
    expect(useExplorer.getState().loading.size).toBe(0);
  });

  it("clears loading even when the root changes mid-load", async () => {
    const pending = useExplorer.getState().loadChildren("/docs/audits");
    await useExplorer.getState().setRoot("/docs");
    await pending;
    expect(useExplorer.getState().loading.has("/docs/audits")).toBe(false);
  });
});
