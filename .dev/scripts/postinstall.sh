#!/usr/bin/env bash
# Copyright (c) 2026 Geoff Seemueller
#
# Licensed under the MIT License or Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# See LICENSE-MIT or LICENSE-APACHE for the full license text.
#
# Additionally, this file is subject to the Revenue Sharing Agreement terms
# as defined in REVENUE-SHARING.md for covered organizations.
# Post-install: wire up local git hooks for developer checkouts.
#
# Skipped when:
#   - $CI is set (covers GitHub Actions, most other CI)
#   - $CARETTA_SKIP_HOOKS=1 (manual opt-out)
#   - this checkout is not inside a git working tree (e.g. tarball install)
#   - the hooks already match the current setup-git-hooks.sh (compared by
#     content hash recorded in <hooks-dir>/.caretta-setup-hash)
set -eu

if [ -n "${CI:-}" ]; then
  exit 0
fi

if [ "${CARETTA_SKIP_HOOKS:-0}" = "1" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP="${SCRIPT_DIR}/setup-git-hooks.sh"

if [ ! -f "${SETUP}" ]; then
  exit 0
fi

if ! git -C "${SCRIPT_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

GIT_DIR="$(git -C "${SCRIPT_DIR}" rev-parse --absolute-git-dir)"
HOOKS_DIR="${GIT_DIR}/hooks"
MARKER="${HOOKS_DIR}/.caretta-setup-hash"

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    # No hasher available; force a re-run by returning a unique value.
    date +%s%N 2>/dev/null || date +%s
  fi
}

CURRENT_HASH="$(hash_file "${SETUP}")"

if [ -f "${MARKER}" ] \
  && [ -f "${HOOKS_DIR}/pre-commit" ] \
  && [ -f "${HOOKS_DIR}/post-commit" ] \
  && [ -f "${HOOKS_DIR}/pre-push" ]; then
  STORED_HASH="$(cat "${MARKER}" 2>/dev/null || true)"
  if [ "${CURRENT_HASH}" = "${STORED_HASH}" ]; then
    exit 0
  fi
fi

bash "${SETUP}"

mkdir -p "${HOOKS_DIR}"
printf '%s\n' "${CURRENT_HASH}" > "${MARKER}"
