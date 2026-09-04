/* ============================================================
   sparkBook · src/shell/ProjectSwitcher.tsx

   Switch between projects (= opened folders). A dialog rather than a
   cascading menu because MenuBar's Dropdown is a flat <ul> with no
   submenu support and the command palette has no sub-item mode.

   Opened by the `spark:projects:open` CustomEvent, the same way every
   other shell dialog is triggered.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@ui/Dialog";
import { Input } from "@ui/Input";
import { Button } from "@ui/Button";
import { Icon } from "@ui/Icon";
import { useProjects, LOOSE_ID, type Project } from "@store/projects";
import { dropProject, mirrorProject } from "@shell/checkpointManager";
import "./ProjectSwitcher.css";

/** "2 hours ago" — coarse on purpose; the list is ordered, not audited. */
export function relativeTime(then: number, now = Date.now()): string {
  if (!then) return "never";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

export function matchesFilter(p: Project, needle: string): boolean {
  if (!needle) return true;
  const hay = `${p.name} ${p.rootPath ?? ""}`.toLowerCase();
  return hay.includes(needle.toLowerCase());
}

export default function ProjectSwitcher() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const renameRef = useRef<HTMLInputElement | null>(null);

  const projects = useProjects((s) => s.projects);
  const activeId = useProjects((s) => s.activeId);
  const renameProject = useProjects((s) => s.renameProject);
  const removeProject = useProjects((s) => s.removeProject);

  useEffect(() => {
    const onOpen = () => {
      setFilter("");
      setRenaming(null);
      setOpen(true);
    };
    window.addEventListener("spark:projects:open", onOpen);
    return () => window.removeEventListener("spark:projects:open", onOpen);
  }, []);

  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  const visible = useMemo(
    () => projects.filter((p) => matchesFilter(p, filter.trim())),
    [projects, filter],
  );

  const switchTo = useCallback((p: Project) => {
    setOpen(false);
    // Switching is a folder open: App's `spark:folder:open` handler owns
    // the flush-then-restore sequence, so there is one code path for
    // "open a folder" whether it came from the dialog or the OS picker.
    window.dispatchEvent(
      new CustomEvent("spark:folder:open", { detail: { path: p.rootPath, projectId: p.id } }),
    );
  }, []);

  const commitRename = useCallback(() => {
    if (renaming) {
      renameProject(renaming, draftName);
      // The mirror only follows the project in front, so a rename here
      // has to reach the checkpoint itself or the next launch undoes it.
      const renamed = useProjects.getState().get(renaming);
      if (renamed) void mirrorProject(renamed);
    }
    setRenaming(null);
  }, [renaming, draftName, renameProject]);

  const forget = useCallback(
    (id: string) => {
      removeProject(id);
      void dropProject(id);
    },
    [removeProject],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Projects"
      description="Folders you have opened. Each remembers its own tabs, tree and terminals."
      size="md"
    >
      <div className="projsw">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter projects…"
          aria-label="Filter projects"
          autoFocus
        />

        {visible.length === 0 ? (
          <p className="projsw__empty">
            {projects.length === 0
              ? "No projects yet — open a folder and it will be remembered here."
              : "No project matches that filter."}
          </p>
        ) : (
          <ul className="projsw__list" role="list">
            {visible.map((p) => (
              <li
                key={p.id}
                className={`projsw__row${p.id === activeId ? " projsw__row--active" : ""}`}
              >
                {renaming === p.id ? (
                  <Input
                    ref={renameRef}
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    aria-label={`Rename ${p.name}`}
                  />
                ) : (
                  <button
                    type="button"
                    className="projsw__main"
                    onClick={() => switchTo(p)}
                    disabled={p.id === LOOSE_ID && !p.rootPath}
                  >
                    <Icon name={p.id === activeId ? "open" : "folder"} size={16} />
                    <span className="projsw__text">
                      <span className="projsw__name">{p.name}</span>
                      <span className="projsw__path">{p.rootPath ?? "Files opened without a folder"}</span>
                    </span>
                    <span className="projsw__meta">
                      {p.workspace.tabs.length > 0 && (
                        <span className="projsw__tabs">
                          {p.workspace.tabs.length} tab{p.workspace.tabs.length === 1 ? "" : "s"}
                        </span>
                      )}
                      <span className="projsw__when">{relativeTime(p.lastOpened)}</span>
                    </span>
                  </button>
                )}

                <span className="projsw__actions">
                  <Button
                    variant="icon"
                    size="sm"
                    aria-label={`Rename ${p.name}`}
                    title="Rename"
                    onClick={() => {
                      setDraftName(p.name);
                      setRenaming(p.id);
                    }}
                  >
                    <Icon name="pencil" size={14} />
                  </Button>
                  <Button
                    variant="icon"
                    size="sm"
                    aria-label={`Remove ${p.name}`}
                    title="Remove from list"
                    onClick={() => forget(p.id)}
                  >
                    <Icon name="trash" size={14} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="projsw__foot">
          <Button
            variant="primary"
            icon="open"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(
                new CustomEvent("spark:command", { detail: { id: "file.openFolder" } }),
              );
            }}
          >
            Open Folder…
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
