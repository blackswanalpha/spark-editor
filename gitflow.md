# Gitflow — Testing, CI & Push PR Automation

> One branching model. One local gate. One remote gate. Zero surprises.

This document defines how `sparkEditor` moves code from a laptop to `main` — automatically tested, linted, built, and shipped through GitHub.

---

## 1. Branching Model

```
main ───────────────────────────────────────────────────────►  protected, releases only
  ▲                                 ▲              ▲
  │ hotfix/* ───────────────────────┘              │
  │ release/* ────────────────────────────────────┘
  │
develop ───────────────────────────────────────────────────►  protected, integration
  ▲         ▲           ▲
  │         │           │
  feature/* feature/*   feature/*  → PRs land here
```

| Branch | Base | Merges to | Purpose | Naming |
|--------|------|-----------|---------|--------|
| `main` | — | — | Production. Tags `v0.1.0`, installers. Protected. | `main` |
| `develop` | `main` | `main` | Next release. All features integrate here. | `develop` |
| `feature/*` | `develop` | `develop` | New work. | `feature/short-slug`, e.g. `feature/rich-tables` |
| `release/*` | `develop` | `main` + back-merge `develop` | Stabilize, bump version, `CHANGELOG`. | `release/0.2.0` |
| `hotfix/*` | `main` | `main` + `develop` | Urgent prod fix. | `hotfix/crash-on-open` |

**Rules**

- Never commit directly to `main` or `develop` — always via PR.
- `main` is always green and releasable. `develop` is always buildable.
- Squash-merge `feature/*` → `develop`. Merge-commit (or squash) `release/*`/`hotfix/*` → `main` to preserve tag boundary.
- Delete the branch on GitHub after merge (auto-delete enabled).

---

## 2. CI Gates

### Local gate (pre-push + `push-pr`)

```bash
npm run ci              # == typecheck → lint → test → build
# or explicitly:
npm run typecheck       # tsc -b --noEmit — no type errors
npm run lint            # eslint . — 0 errors (warnings allowed, see eslint.config.js:24)
npm run test            # vitest run --passWithNoTests — all specs green
npm run build           # tsc -b && vite build — must emit dist/
cargo check             # (if Rust toolchain present) host compiles
```

Wrapped as:

```bash
bash scripts/gitflow.sh check      # same chain + cargo check (advisory)
```

A **Git hook** (`scripts/install-hooks.sh` → `.git/hooks/pre-push`) runs `typecheck + test` on every `git push`. Bypass with `--no-verify` in emergencies only.

### Remote gate (GitHub Actions)

Workflow: `.github/workflows/ci.yml`

- **Trigger:** `push` to `main`/`develop`, `pull_request` to `main`/`develop`, manual dispatch.
- **Concurrency:** cancels outdated runs on the same ref.
- **Jobs:**
  - `frontend` (Ubuntu, Node 20): `npm ci → typecheck → lint → test → build` — **required**.
  - `rust` (Ubuntu, Rust stable): `cargo check + clippy` + Tauri sysdeps — **required on protected branches**, advisory on `feature/*`.
  - `gate` (single required check): `CI gate ✓` — add this name in **Settings → Branches → Branch protection → Require status checks**.

```yaml
# Settings → Branches → Add rule
Branch name: main, develop
☑ Require status checks to pass before merging  →  CI gate ✓
☑ Require branches to be up to date before merging
☑ Do not allow bypassing the above settings
☑ Automatically delete head branches
```

**Test config** (`vite.config.ts:36`): Vitest `passWithNoTests: true`, `jsdom`, `include: ["src/**/*.{test,spec}.{ts,tsx}"]`. Until specs exist, CI stays green.

---

## 3. Day-to-Day Workflows

### 3.1 Bootstrap (once per clone)

```bash
git clone git@github.com:<you>/spark-editor.git
cd spark-editor

npm ci                          # install deps
npm run ci                      # verify local gate
bash scripts/install-hooks.sh   # optional — installs pre-push hook
```

Hooks are also auto-installed by `npm install` via the `prepare` script (`package.json:14`).

### 3.2 New feature

```bash
bash scripts/gitflow.sh branch feature rich-tables
# → creates feature/rich-tables from develop, checks it out

# …hack on src/…

git add -A && git commit -m "feat: add tables to RichEditor

Closes #42"

bash scripts/gitflow.sh push-pr
# 1) runs check (typecheck/lint/test/build)
# 2) git push -u origin feature/rich-tables
# 3) gh pr create --base develop --head feature/rich-tables
#    (or updates existing PR if one already exists)
```

Shortcut without the helper:

```bash
git checkout -b feature/rich-tables develop
git commit -m "feat: ..."
npm run ci && git push -u origin HEAD
gh pr create --base develop --fill
```

### 3.3 Push-PR contract (`scripts/gitflow.sh push-pr`)

`push-pr` is the only blessed path to open a PR. It enforces:

1. **Not on protected branch** — refuses if HEAD is `main`/`develop`.
2. **Local CI must pass** — `typecheck → lint → test → build → cargo check`.
3. **Push** — `git push` (sets upstream on first push).
4. **PR create/update via `gh`**:
   - Base is `develop` for `feature/*`, `main` for `release/*`/`hotfix/*`.
   - If a PR for this branch already exists, pushes new commits to it.
   - Title defaults to the last commit message; edit the GitHub description before review.
   - Requires `gh auth login` (once). Without `gh`, it still pushes and prints the manual-PR URL.

```bash
# prerequisites for auto-PR
gh --version   # ≥ 2.40
gh auth login  # choose SSH + HTTPS
gh auth status # should show ✓ Logged in
```

### 3.4 Keeping a branch fresh

```bash
bash scripts/gitflow.sh sync            # fetch + rebase current branch

# or manually:
git fetch --prune
git rebase origin/develop               # replay feature onto latest develop
# resolve conflicts, then:
git push --force-with-lease
```

### 3.5 Finishing

`scripts/gitflow.sh finish` prints the merge recipe for the current branch. Actual merges happen on GitHub via the PR UI:

```bash
bash scripts/gitflow.sh finish

# Example — after PR is approved + CI gate ✓:
# 1) GitHub → Merge → Squash and merge (feature) / Create a merge commit (release/hotfix)
# 2) Locally:
git checkout develop && git pull --ff-only origin develop
git branch -d feature/rich-tables
# (remote branch auto-deleted by GitHub)
```

**Release flow:**

```bash
bash scripts/gitflow.sh branch release 0.2.0   # from develop
# bump version in package.json + src-tauri/tauri.conf.json, update changelog/0.2.0.md
git commit -m "chore: bump to 0.2.0"
bash scripts/gitflow.sh push-pr               # → PR release/0.2.0 → main
# after merge on GitHub:
git checkout main && git pull
git tag -a v0.2.0 -m "v0.2.0" && git push origin v0.2.0
git checkout develop && git merge main && git push
```

**Hotfix:**

```bash
bash scripts/gitflow.sh branch hotfix crash-on-open   # from main
# …fix…
bash scripts/gitflow.sh push-pr                        # → PR hotfix/crash-on-open → main
# after merge: tag, then back-merge/cherry-pick to develop
```

---

## 4. CI & Automation Wiring

```
npm scripts  ──────────►  local dev
  typecheck, lint,
  test, build, ci,
  gitflow:*              ──►  scripts/gitflow.sh  ──►  git + gh + npm

git hooks                ──►  .git/hooks/pre-push (installed by scripts/install-hooks.sh)
                          ↳  blocks `git push` if typecheck/test fails

GitHub Actions           ──►  .github/workflows/ci.yml
  push/PR to main/develop ──►  frontend + rust + gate
                          ↳  PR cannot merge until `CI gate ✓` is green

PR template              ──►  .github/pull_request_template.md
                          ↳  checklist + base-branch reminder
```

**Wiring proof — every piece is connected:**

| Trigger | What runs | Where to see it |
|---------|-----------|-----------------|
| `git push` | `pre-push` → `typecheck + test` | terminal on push |
| `bash scripts/gitflow.sh push-pr` | `check` → `push` → `gh pr create` | terminal + GitHub PR tab |
| `push` / `pr` to `main`/`develop` | `ci.yml` → `frontend` + `rust` → `gate` | Actions tab, PR checks |
| Branch protection | Blocks merge until `CI gate ✓` | PR → Checks, Settings → Branches |
| `npm install` | `prepare` → `install-hooks.sh` | after `npm ci` |

---

## 5. Configuration Reference

| File | Role |
|------|------|
| `package.json:6` | `ci`, `gitflow*`, `prepare` scripts |
| `eslint.config.js` | Flat ESLint (typescript-eslint + react-hooks). `no-empty`/`no-regex-spaces` = warn so CI stays green on legacy code — tighten per-PR. |
| `vite.config.ts:36` | Vitest: `jsdom`, `passWithNoTests: true`, `include: ["src/**/*.{test,spec}.{ts,tsx}"]` |
| `.github/workflows/ci.yml` | Remote CI: `frontend` + `rust` + `gate` |
| `.github/pull_request_template.md` | PR body template + checklist |
| `scripts/gitflow.sh` | Branch, sync, check, push-pr, finish — the CLI for this doc |
| `scripts/install-hooks.sh` | Installs `.git/hooks/pre-push`. Idempotent. |
| `scripts/hooks/pre-push` | Reference copy of the hook (versioned) |

### npm script map

```json
// package.json
"ci":               "npm run typecheck && npm run lint && npm run test && npm run build",
"gitflow":          "bash scripts/gitflow.sh",
"gitflow:branch":   "bash scripts/gitflow.sh branch",
"gitflow:push":     "bash scripts/gitflow.sh push-pr",
"gitflow:sync":     "bash scripts/gitflow.sh sync",
"prepare":          "bash scripts/install-hooks.sh 2>/dev/null || true"
```

---

## 6. Initializing This Repo (this document's own proof)

The steps below were executed to bring _this_ checkout under gitflow from scratch (see terminal log):

```bash
cd sparkEditor-main

# 1) ensure toolchain
node -v      # v22
rustc -v     # 1.93
gh auth status  # ✓ blackswanalpha

# 2) fix lint + test so CI can go green
#    - add eslint.config.js (flat, typescript-eslint)
#    - fix src/App.tsx duplicate else-if
#    - set vite.config.ts test.passWithNoTests + package.json test --passWithNoTests

# 3) add automation
#    .github/workflows/ci.yml
#    .github/pull_request_template.md
#    scripts/gitflow.sh + scripts/install-hooks.sh

# 4) git init + initial commit + GitHub
git init -b main
git add -A && git commit -m "chore: bootstrap gitflow, CI and tooling"
gh repo create spark-editor --public --source=. --remote=origin --push
# → gh creates remote, pushes main

# 5) create develop + protect
git checkout -b develop && git push -u origin develop
gh api repos/blackswanalpha/spark-editor/branches/main/protection  -X PUT  # require CI gate ✓
gh api repos/blackswanalpha/spark-editor/branches/develop/protection -X PUT # same

# 6) prove PR flow
bash scripts/gitflow.sh branch feature/verify-gitflow
echo "# probe" >> probe.md && git add probe.md && git commit -m "chore: probe gitflow"
bash scripts/gitflow.sh push-pr   # → PR feature/verify-gitflow → develop, CI runs

# 7) clean up probe branch after merge, or close PR if this was a dry run
```

> The repo you are reading (`sparkEditor-main/.git`, `origin` on GitHub) *is* the artefact. `git log --oneline`, `gh pr list`, and `Actions → CI` show the wiring.

---

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `eslint` says "couldn't find config" | Ensure `eslint.config.js` exists at repo root; `npm ls eslint` should be ≥ 9. |
| `vitest run` exits 1 with "No test files found" | Expected before specs exist. `npm run test` uses `--passWithNoTests` — if you call `npx vitest run` bare, add the flag. |
| `scripts/gitflow.sh push-pr` says "Refusing to push-pr from protected branch" | `git checkout -b feature/x develop` first. |
| `gh pr create` → "GraphQL: … not found" | Remote mismatch — `git remote -v` should point to the repo you created. `gh repo view` to verify. |
| `pre-push` blocks push but CI would pass | Hook runs `typecheck + test` only (fast). `npm run lint` runs only in `push-pr` and CI. Bypass hook once: `git push --no-verify`, but fix before PR. |
| `cargo check` fails in CI due to sysdeps | The `rust` job installs `libwebkit2gtk-4.1-dev` etc. Locally, install Tauri prerequisites: https://tauri.app/start/prerequisites/ |
| Branch protection won't let me push to `main` | Intended. Push a `hotfix/*` branch and open a PR. Admins can bypass via Settings → Branches → Allow bypass. |

---

## 8. Further Links

- Tauri prerequisites: https://tauri.app/start/prerequisites/
- GitHub branch protections: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-a-branch-protection-rule
- `gh` manual: https://cli.github.com/manual/
- Vitest: https://vitest.dev/config/
- ESLint flat config: https://eslint.org/docs/latest/use/configure/configuration-files-new

---

*Maintainers: keep this doc in sync with `.github/workflows/ci.yml` and `scripts/gitflow.sh`. If they drift, this doc is wrong — fix it.*
