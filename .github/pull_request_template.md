# Pull Request

## Summary
<!-- One-paragraph: what changed and why. Link issues via `Closes #123`. -->

## Branch
- [ ] `feature/*` → `develop`
- [ ] `release/*` / `hotfix/*` → `main`
- [ ] Other: ___ → ___

## Checklist
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (0 errors)
- [ ] `npm run test` passes
- [ ] `npm run build` succeeds
- [ ] Rust `cargo check` passes (if `src-tauri/` touched)
- [ ] Docs updated (`docs/`, `README.md`, `changelog/` if needed)
- [ ] `designlabs/` updated (if UI changed)

## Screenshots / Video
<!-- Drop before/after screenshots for UI changes. -->

## How to test
```bash
npm ci
npm run ci   # typecheck + lint + test + build
```

## Breaking changes?
- [ ] No
- [ ] Yes — describe migration:

---

<!-- CI runs on every push. Branch protections require `CI gate ✓` to be green before merge. -->
