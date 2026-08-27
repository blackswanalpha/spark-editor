#!/usr/bin/env bash
# Install local git hooks for sparkEditor.
# Idempotent — safe to run multiple times.
# Hooks installed: .git/hooks/pre-push (and optional pre-commit)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$ROOT/.git/hooks"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "No .git directory yet — skipping hook install (run after git init)."
  exit 0
fi

mkdir -p "$HOOK_DIR"

# ---------- pre-push: quick gate (typecheck + test) ----------
cat > "$HOOK_DIR/pre-push" <<'HOOK'
#!/usr/bin/env bash
# pre-push hook — quick gate before push.
# Bypass: git push --no-verify
set -e
echo "▶ pre-push: typecheck + test (bypass with --no-verify)…"
# only run if npm exists and we're in a JS project
if command -v npm >/dev/null 2>&1 && [[ -f "package.json" ]]; then
  npm run typecheck --silent || { echo "✖ typecheck failed"; exit 1; }
  # lint is informational here (full lint runs in CI + push-pr)
  # npm run lint --silent || true
  npm run test --silent || { echo "✖ tests failed"; exit 1; }
  echo "✓ pre-push checks passed"
fi
HOOK

chmod +x "$HOOK_DIR/pre-push"
echo "✓ Installed .git/hooks/pre-push"

# ---------- optional pre-commit: lint staged (if lint-staged exists) ----------
# We keep this lightweight — full lint runs in CI. Uncomment to enforce:
# cat > "$HOOK_DIR/pre-commit" <<'HOOK'
# #!/usr/bin/env bash
# echo "▶ pre-commit: lint"
# npm run lint --silent || exit 1
# HOOK
# chmod +x "$HOOK_DIR/pre-commit"

echo "ℹ Hooks installed. Bypass any hook with --no-verify (e.g., git commit --no-verify, git push --no-verify)."
