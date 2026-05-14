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
# Pre-commit hook: typecheck + test + build for all action packages. If a
# build modifies dist/, regenerated files are staged into the in-flight commit
# so action entrypoints stay in sync with src/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

stage_dist_if_changed() {
  local dist_dir="$1"
  if ! git diff --quiet -- "${dist_dir}"; then
    echo "[pre-commit] staging regenerated ${dist_dir} files:"
    git --no-pager diff --name-only -- "${dist_dir}" | sed 's/^/             /'
    git add -- "${dist_dir}"
  fi
}

echo "[pre-commit] typecheck (root)"
bun run typecheck

echo "[pre-commit] typecheck (work-dispatch-action)"
bun x tsc --noEmit -p packages/work-dispatch-action/tsconfig.json

echo "[pre-commit] typecheck (factory-cycle-action)"
bun x tsc --noEmit -p packages/factory-cycle-action/tsconfig.json

echo "[pre-commit] test"
bun test

if git diff --cached --quiet -- src/ package.json bun.lock tsconfig.json; then
  echo "[pre-commit] root build inputs unchanged, skipping root build"
else
  echo "[pre-commit] build (root action)"
  bun run build
  stage_dist_if_changed dist/
fi

if git diff --cached --quiet -- \
  packages/work-dispatch-action/src/ \
  packages/work-dispatch-action/package.json \
  packages/work-dispatch-action/tsconfig.json \
  bun.lock
then
  echo "[pre-commit] work-dispatch-action build inputs unchanged, skipping build"
else
  echo "[pre-commit] build (work-dispatch-action)"
  (
    cd packages/work-dispatch-action
    bun x ncc build src/index.ts -o dist --source-map --license licenses.txt
  )
  stage_dist_if_changed packages/work-dispatch-action/dist/
fi

if git diff --cached --quiet -- \
  packages/factory-cycle-action/src/ \
  packages/factory-cycle-action/package.json \
  packages/factory-cycle-action/tsconfig.json \
  bun.lock
then
  echo "[pre-commit] factory-cycle-action build inputs unchanged, skipping build"
else
  echo "[pre-commit] build (factory-cycle-action)"
  (
    cd packages/factory-cycle-action
    bun x ncc build src/index.ts -o dist --source-map --license licenses.txt
  )
  stage_dist_if_changed packages/factory-cycle-action/dist/
fi
HOOK

cat > "${PRE_PUSH}" <<'HOOK'
#!/usr/bin/env bash
# Pre-push hook: tests + verify all action dist/ outputs are current with src/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "[pre-push] test"
bun test

echo "[pre-push] typecheck (work-dispatch-action)"
bun x tsc --noEmit -p packages/work-dispatch-action/tsconfig.json

echo "[pre-push] typecheck (factory-cycle-action)"
bun x tsc --noEmit -p packages/factory-cycle-action/tsconfig.json

echo "[pre-push] build (root action)"
bun run build

echo "[pre-push] build (work-dispatch-action)"
(
  cd packages/work-dispatch-action
  bun x ncc build src/index.ts -o dist --source-map --license licenses.txt
)

echo "[pre-push] build (factory-cycle-action)"
(
  cd packages/factory-cycle-action
  bun x ncc build src/index.ts -o dist --source-map --license licenses.txt
)

DIRTY=0
for DIST_DIR in \
  dist/ \
  packages/work-dispatch-action/dist/ \
  packages/factory-cycle-action/dist/
do
  if ! git diff --quiet -- "${DIST_DIR}"; then
    DIRTY=1
    echo
    echo "[pre-push] ${DIST_DIR} is out of date:"
    git --no-pager diff --stat -- "${DIST_DIR}" | sed 's/^/             /'
  fi
done

if [[ "${DIRTY}" -ne 0 ]]; then
  echo
  echo "[pre-push] one or more dist/ outputs are out of date."
  echo "           commit the generated changes (a fresh commit re-runs pre-commit),"
  echo "           then push again."
  echo
  exit 1
fi
HOOK

chmod +x "${PRE_COMMIT}" "${PRE_PUSH}"

echo "Installed hooks:"
echo "  ${PRE_COMMIT}"
echo "  ${PRE_PUSH}"
