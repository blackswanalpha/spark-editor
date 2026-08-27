#!/usr/bin/env bash
# ============================================================
# sparkEditor — Gitflow helper
# Wraps common gitflow operations + CI gate + GitHub PR automation.
#
# Usage:
#   bash scripts/gitflow.sh branch  feature my-cool-thing
#   bash scripts/gitflow.sh branch  hotfix  urgent-fix
#   bash scripts/gitflow.sh sync
#   bash scripts/gitflow.sh check        # local CI gate
#   bash scripts/gitflow.sh push-pr      # check + push + create/refresh PR
#   bash scripts/gitflow.sh finish       # merge helpers (informational)
#   bash scripts/gitflow.sh help
#
# Requires: git, gh (GitHub CLI), npm (for check/push-pr)
# Install gh: https://cli.github.com/ | gh auth login
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---------- helpers ----------
red()  { printf "\033[31m%s\033[0m\n" "$*"; }
green(){ printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){printf "\033[33m%s\033[0m\n" "$*"; }
die()  { red "✖ $*"; exit 1; }
info() { printf "▶ %s\n" "$*"; }

# infer defaults from git
default_remote="$(git remote 2>/dev/null | head -n1 || echo origin)"
current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

# branch type → base
base_for() {
  case "$1" in
    feature) echo "develop" ;;
    release) echo "develop" ;;
    hotfix)  echo "main" ;;
    *) echo "develop" ;;
  esac
}

cmd_branch() {
  local type="${1:-}"; local name="${2:-}"
  [[ -z "$type" || -z "$name" ]] && die "usage: gitflow.sh branch <feature|release|hotfix> <name>"
  # normalize
  type="$(echo "$type" | tr '[:upper:]' '[:lower:]')"
  [[ "$type" =~ ^(feature|release|hotfix)$ ]] || die "type must be feature|release|hotfix"
  # slugify name
  local slug
  slug="$(echo "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g')"
  [[ -z "$slug" ]] && die "invalid name '$name'"

  # ensure we're up to date on base
  local base; base="$(base_for "$type")"
  info "Fetching from $default_remote…"
  git fetch "$default_remote" --prune

  if git show-ref --verify --quiet "refs/heads/$base"; then
    info "Checking out base '$base' and pulling…"
    git checkout "$base"
    git pull --ff-only "$default_remote" "$base" || yellow "⚠ pull failed — continuing (maybe no remote $base yet)"
  else
    # try remote branch
    if git show-ref --verify --quiet "refs/remotes/$default_remote/$base"; then
      info "Creating local '$base' from $default_remote/$base…"
      git checkout -b "$base" "$default_remote/$base"
    else
      yellow "⚠ Base '$base' not found locally or remotely — creating from HEAD ($current_branch)"
      # stay on current
    fi
  fi

  local full="$type/$slug"
  if git show-ref --verify --quiet "refs/heads/$full"; then
    die "branch '$full' already exists locally. git checkout $full"
  fi
  info "Creating branch '$full' from $(git rev-parse --abbrev-ref HEAD)…"
  git checkout -b "$full"
  green "✓ Created and checked out $full"
  echo ""
  echo "Next:"
  echo "  # hack…"
  echo "  git add -A && git commit -m \"feat: $slug\""
  echo "  bash scripts/gitflow.sh push-pr"
}

cmd_sync() {
  info "Fetching + pruning $default_remote…"
  git fetch "$default_remote" --prune
  local br; br="$(git rev-parse --abbrev-ref HEAD)"
  info "Rebasing $br onto $default_remote/$br (if tracking)…"
  if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
    git pull --rebase --autostash || yellow "⚠ pull --rebase had conflicts — resolve manually"
  else
    yellow "⚠ No upstream for $br — skipping pull. Use: git push -u $default_remote $br"
  fi
  green "✓ Sync done"
}

cmd_check() {
  info "Running local CI gate (typecheck → lint → test → build)…"
  if command -v npm >/dev/null 2>&1; then
    npm run typecheck
    # lint: fail on errors, allow warnings (eslint returns 0 when only warnings if configured)
    # our config downgrades legacy errors to warnings, so this is strict
    npm run lint
    npm run test
    npm run build
  else
    die "npm not found"
  fi
  # rust check if cargo exists and src-tauri changed or --rust flag?
  if command -v cargo >/dev/null 2>&1 && [[ -d "src-tauri" ]]; then
    info "Running cargo check (src-tauri)…"
    (cd src-tauri && cargo check 2>&1 | tail -n 30) || yellow "⚠ cargo check failed (advisory)"
  fi
  green "✓ Local CI gate passed"
}

cmd_push_pr() {
  local br; br="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$br" == "main" || "$br" == "develop" ]] && die "Refusing to push-pr from protected branch '$br'. Create a feature branch: bash scripts/gitflow.sh branch feature my-change"

  info "Branch: $br"
  # 1) local gate (fail fast before push)
  cmd_check

  # 2) push
  info "Pushing $br to $default_remote…"
  # set upstream on first push
  if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
    git push
  else
    git push -u "$default_remote" "$br"
  fi

  # 3) figure out PR base
  local base="develop"
  if [[ "$br" == hotfix/* ]]; then base="main"; fi
  if [[ "$br" == release/* ]]; then base="main"; fi

  # check gh
  if ! command -v gh >/dev/null 2>&1; then
    yellow "⚠ gh CLI not installed — pushed, but skipping PR creation. Install from https://cli.github.com/"
    green "✓ Pushed $br → $default_remote (create PR manually: $base ← $br)"
    return 0
  fi
  if ! gh auth status >/dev/null 2>&1; then
    yellow "⚠ gh not authenticated — run: gh auth login"
    green "✓ Pushed $br (create PR manually)"
    return 0
  fi

  # 4) create or refresh PR
  local existing
  existing="$(gh pr view "$br" --json number --jq .number 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    green "✓ PR #$existing already exists for $br — pushed new commits"
    gh pr view "$existing" --web 2>/dev/null || gh pr view "$br" --json url --jq .url
  else
    # infer title from last commit or branch name
    local title
    title="$(git log -1 --pretty=%s 2>/dev/null || echo "$br")"
    local body
    body="$(cat <<EOF
## Summary
Automated PR: \`$br\` → \`$base\`

- Branch: \`$br\`
- Base: \`$base\`
- Local CI: \`npm run ci\` passed at push time.

## Checklist
- [x] typecheck, lint, test, build passed locally
- [ ] CI gate ✓ (GitHub Actions)

> Created by \`scripts/gitflow.sh push-pr\`. Edit this description before requesting review.
EOF
)"
    info "Creating PR: $br → $base…"
    gh pr create --base "$base" --head "$br" --title "$title" --body "$body" --fill-verbose 2>&1 || \
    gh pr create --base "$base" --head "$br" --title "$title" --body "$body"
    green "✓ PR created: $br → $base"
  fi
}

cmd_finish() {
  local br; br="$(git rev-parse --abbrev-ref HEAD)"
  cat <<EOF
Finish helper — manual steps (keeps history clean):

  Current branch: $br

  For feature/* → develop:
    1) Ensure PR is approved + CI gate ✓
    2) On GitHub: Squash & merge (or merge commit if you want history)
    3) Locally:
       git checkout develop
       git pull --ff-only $default_remote develop
       git branch -d $br
       git push $default_remote --delete $br  # optional — GitHub auto-deletes if enabled

  For release/* → main (+ back-merge to develop):
    gh pr create --base main --head $br  # if not already
    # after merge to main:
    git checkout main && git pull
    git tag -a v0.1.0 -m "v0.1.0" && git push $default_remote v0.1.0
    git checkout develop && git merge main && git push

  For hotfix/* → main (+ cherry-pick to develop):
    gh pr create --base main --head $br
    # after merge:
    git checkout develop && git cherry-pick main  # or merge main

  Tip: use GitHub's "Squash and merge" to keep linear history, or
       "Create a merge commit" to preserve branch topology.
EOF
}

cmd_help() {
  cat <<'EOF'
sparkEditor gitflow — helpers

  bash scripts/gitflow.sh branch <type> <name>   create feature/release/hotfix branch
  bash scripts/gitflow.sh sync                   fetch + rebase current branch
  bash scripts/gitflow.sh check                  run local CI gate (typecheck/lint/test/build)
  bash scripts/gitflow.sh push-pr                check + push + create/update PR via gh
  bash scripts/gitflow.sh finish                 show merge instructions for current branch
  bash scripts/gitflow.sh help                   this help

Branching model (gitflow):
  main            — protected, releases only, deploys
  develop         — integration, next release
  feature/*       — from develop → PR to develop
  release/*       — from develop → PR to main (changelog, version bump)
  hotfix/*        — from main    → PR to main  (+ back-merge to develop)

CI wiring:
  • Local:  npm run ci  == typecheck + lint + test + build
            bash scripts/gitflow.sh check   (same, plus cargo check if present)
  • Remote: .github/workflows/ci.yml runs on push/PR to main/develop
            Required status check: "CI gate ✓" — enable in branch protection.
  • Hooks:  scripts/install-hooks.sh installs pre-push hook that runs `npm run typecheck && npm run test` quickly.
            Bypass with --no-verify if needed: git push --no-verify

Quick start:
  bash scripts/gitflow.sh branch feature my-thing
  # …hack…
  git add -A && git commit -m "feat: my-thing"
  bash scripts/gitflow.sh push-pr   # → pushes + opens PR develop ← feature/my-thing

See gitflow.md for full guide.
EOF
}

# ---------- dispatch ----------
case "${1:-help}" in
  branch)  shift; cmd_branch "$@" ;;
  sync)    shift; cmd_sync "$@" ;;
  check)   shift; cmd_check "$@" ;;
  push-pr|push|pr) shift; cmd_push_pr "$@" ;;
  finish)  shift; cmd_finish "$@" ;;
  help|--help|-h|"") cmd_help ;;
  *) die "unknown command '$1' — try: bash scripts/gitflow.sh help" ;;
esac
