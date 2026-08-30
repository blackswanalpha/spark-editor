/* sparkEditor · src/store/documents.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@bridge/commands", () => ({
  writeFile: vi.fn(async (_path, _contents) => ({
    path: _path,
    bytes: _contents.length,
    mtime: new Date().toISOString(),
    device: 0,
    inode: 0,
  })),
  saveFileDialog: vi.fn(async () => null),
  recentsAdd: vi.fn(async (p) => ["/welcome.md", p]),
}));

import { useDocs, basename } from "./documents";
import { writeFile, saveFileDialog, recentsAdd } from "@bridge/commands";

const mockedWriteFile = vi.mocked(writeFile);
const mockedSaveFileDialog = vi.mocked(saveFileDialog);
const mockedRecentsAdd = vi.mocked(recentsAdd);

const resetStore = () => {
  useDocs.setState({ docs: {}, order: [], active: null, history: {} });
};

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe("basename", () => {
  it("posix", () => expect(basename("/a/b/c.md")).toBe("c.md"));
  it("windows", () => expect(basename("C:\\Users\\foo\\bar.txt")).toBe("bar.txt"));
  it("root", () => expect(basename("/")).toBe(""));
  it("empty", () => expect(basename("")).toBe(""));
  it("trailing slash", () => expect(basename("/a/b/")).toBe("b"));
});

describe("saveDocument", () => {
  it("happy path", async () => {
    const id = useDocs.getState().open({ name: "c.md", path: "/a/b/c.md", raw: "hello" });
    useDocs.getState().setRaw(id, "hello world");
    const r = await useDocs.getState().saveDocument(id);
    expect(r).toEqual({ ok: true, path: "/a/b/c.md" });
    expect(mockedWriteFile).toHaveBeenCalledWith("/a/b/c.md", "hello world");
    expect(mockedRecentsAdd).toHaveBeenCalledWith("/a/b/c.md");
    const doc = useDocs.getState().docs[id];
    expect(doc.dirty).toBe(false);
    expect(doc.path).toBe("/a/b/c.md");
    expect(doc.name).toBe("c.md");
  });

  it("no active doc", async () => {
    const r = await useDocs.getState().saveDocument("nope");
    expect(r).toEqual({ ok: false, reason: "no-active-doc" });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("no path", async () => {
    const id = useDocs.getState().open({ name: "untitled", path: null, raw: "x" });
    useDocs.getState().setRaw(id, "x y");
    const r = await useDocs.getState().saveDocument(id);
    expect(r).toEqual({ ok: false, reason: "no-path" });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });

  it("error keeps dirty", async () => {
    const id = useDocs.getState().open({ name: "c.md", path: "/a/b/c.md", raw: "x" });
    useDocs.getState().setRaw(id, "x y");
    mockedWriteFile.mockRejectedValueOnce(new Error("boom"));
    const r = await useDocs.getState().saveDocument(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("error");
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });
});

describe("saveDocumentAs", () => {
  it("happy path with dialog", async () => {
    const id = useDocs.getState().open({ name: "untitled", path: null, raw: "hi" });
    useDocs.getState().setRaw(id, "hi there");
    mockedSaveFileDialog.mockResolvedValueOnce("/foo/bar.md");
    const r = await useDocs.getState().saveDocumentAs(id);
    expect(r).toEqual({ ok: true, path: "/foo/bar.md" });
    expect(mockedWriteFile).toHaveBeenCalledWith("/foo/bar.md", "hi there");
    expect(mockedRecentsAdd).toHaveBeenCalledWith("/foo/bar.md");
    const doc = useDocs.getState().docs[id];
    expect(doc.dirty).toBe(false);
    expect(doc.path).toBe("/foo/bar.md");
    expect(doc.name).toBe("bar.md");
  });

  it("cancel", async () => {
    const id = useDocs.getState().open({ name: "untitled", path: null, raw: "x" });
    useDocs.getState().setRaw(id, "x y");
    mockedSaveFileDialog.mockResolvedValueOnce(null);
    const r = await useDocs.getState().saveDocumentAs(id);
    expect(r).toEqual({ ok: false, reason: "cancelled" });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });

  it("error after picking", async () => {
    const id = useDocs.getState().open({ name: "untitled", path: null, raw: "x" });
    useDocs.getState().setRaw(id, "x y");
    mockedSaveFileDialog.mockResolvedValueOnce("/x.md");
    mockedWriteFile.mockRejectedValueOnce(new Error("disk full"));
    const r = await useDocs.getState().saveDocumentAs(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("error");
    expect(useDocs.getState().docs[id].dirty).toBe(true);
  });
});

describe("saveAllDirty", () => {
  it("saves both with dialog for unpathed", async () => {
    const id1 = useDocs.getState().open({ name: "a.md", path: "/a.md", raw: "a" });
    useDocs.getState().setRaw(id1, "a body");
    const id2 = useDocs.getState().open({ name: "b.md", path: null, raw: "b" });
    useDocs.getState().setRaw(id2, "b body");
    mockedSaveFileDialog.mockResolvedValueOnce("/b.md");
    const r = await useDocs.getState().saveAllDirty();
    expect(r.cancelled).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.saved.sort()).toEqual(["/a.md", "/b.md"].sort());
    expect(mockedWriteFile).toHaveBeenCalledWith("/a.md", "a body");
    expect(mockedWriteFile).toHaveBeenCalledWith("/b.md", "b body");
    expect(useDocs.getState().docs[id1].dirty).toBe(false);
    expect(useDocs.getState().docs[id2].dirty).toBe(false);
  });

  it("cancel mid-batch stops subsequent saves", async () => {
    const id1 = useDocs.getState().open({ name: "a.md", path: "/a.md", raw: "a" });
    useDocs.getState().setRaw(id1, "a body");
    const id2 = useDocs.getState().open({ name: "b.md", path: null, raw: "b" });
    useDocs.getState().setRaw(id2, "b body");
    const id3 = useDocs.getState().open({ name: "c.md", path: null, raw: "c" });
    useDocs.getState().setRaw(id3, "c body");
    mockedSaveFileDialog.mockResolvedValueOnce(null);
    mockedSaveFileDialog.mockResolvedValueOnce("/c.md");
    const r = await useDocs.getState().saveAllDirty();
    expect(r.cancelled).toBe(true);
    expect(r.saved).toEqual(["/a.md"]);
    expect(r.errors).toEqual([]);
    expect(useDocs.getState().docs[id1].dirty).toBe(false);
    expect(useDocs.getState().docs[id2].dirty).toBe(true);
    expect(useDocs.getState().docs[id3].dirty).toBe(true);
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).toHaveBeenCalledWith("/a.md", "a body");
  });
});

describe("document store — lifecycle races", () => {
  beforeEach(() => {
    useDocs.setState({ docs: {}, order: [], active: null, history: {} });
  });

  it("ignores writes to a document that was already closed", () => {
    // An editor's debounced onChange can land after the tab closed. The
    // unguarded spread used to resurrect a half-built ghost document.
    const id = useDocs.getState().open({ name: "a.md", raw: "one" });
    useDocs.getState().close(id);

    useDocs.getState().setRaw(id, "two");
    useDocs.getState().setCursor(id, { line: 9, col: 9 });
    useDocs.getState().setMode(id, "code");
    useDocs.getState().markClean(id);
    useDocs.getState().setName(id, "ghost");
    useDocs.getState().setPath(id, "/ghost");

    expect(useDocs.getState().docs[id]).toBeUndefined();
    expect(useDocs.getState().order).toEqual([]);
  });

  it("does not crash when history was dropped but the doc remains", () => {
    const id = useDocs.getState().open({ name: "a.md", raw: "one" });
    // Simulate a torn state: doc present, history gone.
    useDocs.setState((s) => ({ ...s, history: {} }));
    expect(() => useDocs.getState().setRaw(id, "two")).not.toThrow();
    expect(useDocs.getState().docs[id].raw).toBe("two");
  });

  it("setActive refuses an id that is not open", () => {
    const id = useDocs.getState().open({ name: "a.md" });
    useDocs.getState().setActive("doc-does-not-exist");
    expect(useDocs.getState().active).toBe(id);
  });

  it("closing a middle tab focuses its neighbour, not the last tab", () => {
    const a = useDocs.getState().open({ name: "a.md" });
    const b = useDocs.getState().open({ name: "b.md" });
    const c = useDocs.getState().open({ name: "c.md" });
    useDocs.getState().setActive(b);
    useDocs.getState().close(b);
    expect(useDocs.getState().active).toBe(c);
    expect(useDocs.getState().order).toEqual([a, c]);
  });

  it("closing the last tab falls back to the new last", () => {
    const a = useDocs.getState().open({ name: "a.md" });
    const b = useDocs.getState().open({ name: "b.md" });
    useDocs.getState().setActive(b);
    useDocs.getState().close(b);
    expect(useDocs.getState().active).toBe(a);
  });

  it("closing the only tab clears the active id", () => {
    const a = useDocs.getState().open({ name: "a.md" });
    useDocs.getState().close(a);
    expect(useDocs.getState().active).toBeNull();
  });

  it("closing twice is a no-op", () => {
    const a = useDocs.getState().open({ name: "a.md" });
    useDocs.getState().close(a);
    expect(() => useDocs.getState().close(a)).not.toThrow();
    expect(useDocs.getState().order).toEqual([]);
  });
});
