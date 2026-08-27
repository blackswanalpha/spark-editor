# changelog/

- `CHANGELOG.md` — canonical, Keep-a-Changelog + SemVer history. One heading per version; `Unreleased` at the top.
- `0.1.0.md` — per-version snapshot (mirrors the `0.1.0` heading in `CHANGELOG.md`) for release-note tooling.
- Future releases add `0.2.0.md`, etc., and move the `Unreleased` items into a new dated heading in `CHANGELOG.md`.

Workflow:

1. Add user-visible changes under `Unreleased` in `CHANGELOG.md` as you work (log day-to-day detail in `../worklog.md`).
2. On release, rename `Unreleased` → `[x.y.z] - YYYY-MM-DD`, add a new empty `Unreleased` at the top, and copy the heading into `x.y.z.md`.
3. Tag `vX.Y.Z` and link the compare URLs at the bottom of `CHANGELOG.md`.
