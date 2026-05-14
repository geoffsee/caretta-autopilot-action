#!/usr/bin/env bash
# Install pre-commit and pre-push hooks for caretta-autopilot-action.
# Run from anywhere inside the package:
#   bash .dev/scripts/setup-git-hooks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PKG_ROOT}"

HOOKS_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "${HOOKS_DIR}"

PRE_COMMIT="${HOOKS_DIR}/pre-commit"
PRE_PUSH="${HOOKS_DIR}/pre-push"

cat > "${PRE_COMMIT}" <<'HOOK'
#!/usr/bin/env bash
# Pre-commit hook: typecheck + build. If the build modifies dist/, the
# regenerated files are staged into the in-flight commit so the action
# entrypoint stays in sync with src/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "[pre-commit] typecheck"
bun run typecheck

# Skip the bundle rebuild when no source files affecting it are staged.
if git diff --cached --quiet -- src/ package.json bun.lock tsconfig.json; then
  echo "[pre-commit] no src/build inputs staged, skipping build"
  exit 0
fi

echo "[pre-commit] build"
bun run build

if ! git diff --quiet -- dist/; then
  echo "[pre-commit] staging regenerated dist/ files:"
  git --no-pager diff --name-only -- dist/ | sed 's/^/             /'
  git add -- dist/
fi
HOOK

cat > "${PRE_PUSH}" <<'HOOK'
#!/usr/bin/env bash
# Pre-push hook: tests + verify dist/ is current with src/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "[pre-push] test"
bun test

echo "[pre-push] build (verify dist is current)"
bun run build

if ! git diff --quiet -- dist/; then
  echo
  echo "[pre-push] dist/ is out of date — rebuild produced changes that are not committed."
  echo "           commit the dist/ changes (a fresh commit re-runs pre-commit, which stages them),"
  echo "           then push again:"
  echo
  git --no-pager diff --stat -- dist/ | sed 's/^/             /'
  echo
  exit 1
fi
HOOK

chmod +x "${PRE_COMMIT}" "${PRE_PUSH}"

echo "Installed hooks:"
echo "  ${PRE_COMMIT}"
echo "  ${PRE_PUSH}"
