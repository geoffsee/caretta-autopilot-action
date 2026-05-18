---
title: Post-mortem — "everything is fucked now"
date: 2026-05-17
status: Resolved (same day); diagnostic preserved
---

# Post-mortem: the CI-dispatch iteration spiral has left the action in a broken, uncommitted state

**Date:** 2026-05-17
**Status:** Resolved same day in commit `c7e0aa0`. The diagnostic below was written *before* re-reading the 23-file diff. See **Resolution (2026-05-17)** at the top for what the diff actually contained and what the lasting lessons are — both of which differ from the diagnostic.

## Resolution (2026-05-17)

After this post-mortem was drafted, the diff was read end-to-end and turned out to be **four coherent themes**, not a spiral, with all 222 tests passing:

- **A — Agent-branch regex flex.** `^agent/issue-[0-9]+$` rejected `agent/issue-123-fix-bug`-style suffixes, so the dispatcher silently skipped those PRs. Loosened to allow an optional `-<desc>` suffix in both this action and `work-dispatch-action`.
- **B — `"workflow / job"` check naming.** GitHub Actions reports checks as `CI / Test`, but the gate compared against the bare `Test`. Added `matchesGateCheckName`, applied it in `latestNamedCheck` and in `listCheckRuns`'s status-shadowing, and exposed `test-check-name` as an action input.
- **C — Idempotent dispatch.** `dispatchMissingCi` and `processAgentPRs` re-dispatched whenever the latest check was not `success`, including for `in_progress` / `queued`. Added `isNamedCheckActivelyRunning` and short-circuit on it.
- **D — Post-execute re-scan.** Commits pushed by `executeAutopilot` using the default `GITHUB_TOKEN` don't trigger `push`/`pull_request` workflows. Re-scan PRs after `executeAutopilot` returns so a second `processAgentPRs` pass can dispatch CI on the new tips.

Landed as a single commit (`c7e0aa0`) with the four themes broken out in the commit message body. The pre-commit hook rebuilt `dist/` for all three packages so source and bundled output stayed in sync.

What was actually true vs. what this post-mortem assumed:

| This post-mortem said | Diff inspection showed |
| --- | --- |
| "11 commits of spiral iteration, plus a 12th attempt mid-progress" | The 23-file diff was the **convergence**, not a 12th symptom-chase — it closes the four gaps the prior 11 commits had left open |
| "No commit captures a known-good baseline" | `HEAD` had 222/0 tests; the working tree also had 222/0 tests — there was a baseline; we just hadn't committed forward from it |
| "Tests encode the bug" | The added tests (suffix branches, `CI / Test` matching, in-progress short-circuit) encode the **contract** the diff is enforcing, not the bug |
| "Two abstractions, one job" | `check-runs.ts` and `github-client.ts` are now coordinated through the shared `matchesGateCheckName` predicate; the dispatch pair (`ci-dispatcher.ts` / `pr-ci.ts`) share `ci-dispatch-core.ts` |

### Lessons (revised — these are the ones to keep)

1. **Read the diff before declaring spiral.** Frustration plus a large file count plus an uncommitted working tree pattern-matches to "iteration spiral" — but the actual content can be convergent work that just hasn't been committed yet. The cost of reading the diff first is much lower than the cost of a wrong rewrite. This post-mortem was about to recommend a contract-first rewrite of code that was, in fact, the contract being enforced.
2. **An uncommitted working tree is not the same as a broken one.** "No commit captures the current state" is a workflow problem, not a code problem. The fix is `git commit`, not `git reset`.
3. **The pre-commit hook earned its keep.** Three packages' `dist/` rebuilt automatically and stayed in sync with source. The earlier-stated worry about source/dist drift was nullified by tooling that already existed.
4. **The 11 prior commits were not wasted.** The four themes that landed today were only reachable because of the scaffolding from `ci-dispatch-core.ts`, `getPrCiSnapshot`, `dispatchOrRerunCi`, `createCommitStatus`, the workflow-run sync, and the check-runs-vs-status precedence. Iterations that *feel* expensive can still be load-bearing for the convergence step.

The diagnostic that follows is preserved unchanged, because the *act of writing it* — and the contrast between its conclusions and the actual diff — is itself the most useful artifact in this file.

---

## Original diagnostic (preserved as written)

**Status (as written):** Unresolved. The working tree has 23 modified files across `src/`, `packages/`, `tests/`, and `dist/`, no commit captures the current state, and the behavior we have been iterating on (getting PR checks to actually run and report) is still not working end-to-end.

## Summary

Over the last several weeks we made **11 separate commits whose stated purpose was to get checks running** — to dispatch CI, surface pending/error commit statuses, reconcile check runs with commit statuses, re-dispatch after automerge-queue advances, etc. After all of that:

- The action still does not reliably do the thing those 11 commits were attempting.
- The current working tree carries another in-progress attempt — 23 modified files, including the bundled `dist/` — that has not been committed and is no longer in a coherent state.
- Two earlier post-mortems (`2026-05-15-autopilot-ci-wait-on-conflict.md`, `2026-05-15-rulesets-and-workflow-permissions.md`) already flagged the underlying gap, and the fixes shipped since then have not closed it.

The honest framing: this is not a single bug. It is an iteration spiral. Each fix has been scoped narrowly to whatever symptom was visible in the previous run, and the cumulative effect is a CI-dispatch surface that nobody can hold in their head, with no commit that represents a known-good baseline to roll back to.

## Impact

- **No safe rollback point.** The dispatch logic has been touched in 11 of the last ~30 commits. Reverting one symptom-fix tends to surface a different symptom that an earlier fix masked.
- **Uncommitted work risk.** The current 23-file diff is not on any branch; a stash mishap or a stray `git checkout` would lose it. This includes regenerated `dist/` bytes that other consumer repos pull from `@main`.
- **Eroded trust in the test suite.** Tests have been added alongside each fix, but they encode the shape of that specific fix rather than the contract the action owes its callers. Green tests no longer imply working CI dispatch in production.
- **Cost to operators.** Every "did the check ever fire?" question still requires inspecting raw API responses, because the per-poll status table proposed on 2026-05-15 was never implemented.

## What we actually did (the 11 attempts)

Listed newest-first so the iteration shape is visible:

1. `498b079` — Extract `getPrCiSnapshot` / `dispatchOrRerunCi`. (Refactor of (2) and (3).)
2. `1c06d6f` — Set pending/error commit statuses around dispatch.
3. `c1dec2a` — Prefer check runs over commit statuses with the same name.
4. `977b1ab` — Sync PR status with completed workflow runs in `runCiGate`.
5. `8036f63` — Add `createCommitStatus` for immediate pending updates.
6. `caf2a0a` — Improve failed-job re-runs + combined-status support.
7. `194b246` — Generic "update CI handling logic" + tests.
8. `1e0ff12` — Re-dispatch CI after automerge-queue advances branch tips.
9. `ea69c73` — Three post-mortems on CI stalls / app install / rulesets.
10. `b347d3a` — Remove busy-state checks from workflow dispatch.
11. `94b2201` — Pin Bun in CI to stop the runner from breaking.

Pattern: each commit addresses a symptom observed in the run *after* the previous commit. There is no commit on this list whose message is "establish the dispatch contract" or "define what 'checks running' means for this action." The contract has been implicit and shifting, which is why fixes keep colliding.

## Root cause (meta)

The CI-dispatch path in this action has three conceptually distinct responsibilities and we have been editing them as if they were one:

1. **Decide whether a check needs to run** on a given PR head SHA (does one already exist? did it fail? has the head advanced?).
2. **Dispatch or re-run the workflow** that produces that check.
3. **Report the resulting state back** as a commit status and/or check run that the PR's protection rules will honor.

Each of the 11 commits touched some subset of these without a written boundary between them. So:

- (3) and (4) disagree about whether a check run or a commit status is the source of truth.
- (2) and (5) both add pending-status writes, on overlapping code paths.
- (1) refactors (2) and (3) but does not address that disagreement; it just makes the disagreement reusable.
- (8) re-dispatches in a case (6) thought it had already handled.

There is no module today that owns "the answer" to "is CI running for this PR?" — every caller computes it slightly differently.

## Why the 23-file uncommitted diff exists

The current working tree is mid-attempt at yet another pass over the same surface: `ci-dispatch-core.ts`, `ci-dispatcher.ts`, `pr-ci.ts`, `check-runs.ts`, `github-client.ts`, plus tests and the bundled `dist/`. The diff looks like more of the same iteration shape — small targeted edits across many files, no single file rewritten from a fresh contract. Without a written contract to write *toward*, this pass will land in the same place as the previous ten.

## What "fucked" specifically means right now

In rough order of severity:

1. **No checkpoint.** Nothing on disk represents a known-working state. `HEAD` (`498b079`) is the last "passes tests" commit but does not, by operator report, actually keep checks running end-to-end.
2. **`dist/` is dirty.** The bundled output reflects the in-progress source, so even a temporary `git stash` of source would leave `dist/` and source out of sync.
3. **Tests encode the bug.** Several tests in `tests/ci-dispatcher.test.ts`, `tests/pr-ci.test.ts`, and `tests/github.test.ts` assert the *current* behavior of overlapping pending-status writes and check-vs-status precedence. A clean reimplementation would have to delete or rewrite them; they cannot be used as a regression net.
4. **Two abstractions, one job.** `check-runs.ts` and `github-client.ts` both read check/status data; `ci-dispatcher.ts` and `pr-ci.ts` both dispatch. Neither pair has a clear owner.
5. **Cross-package coupling.** `packages/action-common` has been modified alongside the action itself in the same uncommitted diff, so any rollback in this package implies a rollback in the shared package too.

## What we are *not* going to do

- **Not another targeted fix.** Adding a 12th commit in the same shape will produce a 12th symptom. The next change to this surface should be a rewrite against a written contract, not another edit.
- **Not "just commit it."** Capturing the current diff as a commit without first deciding what it is supposed to mean preserves the mess and pretends it is intentional. The diff should be saved (branch + stash, both) but not landed on `main`.
- **Not delete the tests.** They document the historical shape of the bug surface and will inform the new contract's test plan.

## Immediate actions (this week)

1. **Snapshot the current state without landing it.** Create a branch `wip/ci-dispatch-2026-05-17` containing the 23-file diff and push it. Then `git stash` a second copy locally as belt-and-braces. Do not merge.
2. **Write the contract before any more code changes.** A short document (`.dev/docs/contracts/ci-dispatch.md`) that states, in one page:
   - The inputs the dispatch path may rely on (PR number, head SHA, base, mergeable, existing checks, existing statuses, workflow file path).
   - The single question each function answers (no overlaps).
   - The side effects each function may perform (no module may both decide and dispatch).
   - The observable outcome the action guarantees to a caller ("after this returns, either a `Test` check is running on `head_sha`, or we have logged why one cannot be").
3. **Identify the last commit at which the action actually worked in a consumer repo.** This is an empirical question, not a code-reading one. Pick a representative consumer repo, walk back through the 11 commits via `gh workflow run` on each, and mark the first one that produces a green `Test` check end-to-end. That commit becomes the rollback target if step 4 stalls.
4. **Decide rewrite vs. continue.** With the contract in hand, re-evaluate whether the existing four modules (`ci-dispatch-core`, `ci-dispatcher`, `pr-ci`, `check-runs`) can be reshaped to match it, or whether a single new `CiDispatch` module replaces them. Bias toward the latter; the existing module boundaries are the artifact of the iteration spiral.

## Follow-ups (after the immediate actions)

- **Per-poll status table** (carried over from 2026-05-15). Until the wait loop self-describes, every future stall will require the same forensic dig. This is independent of the rewrite and can ship alongside it.
- **Move `dist/` out of the commit path.** Have CI build `dist/` and publish it to a release tag, so source commits do not have to carry generated bytes that go stale during in-progress work. (Separate effort; flagged here because the current `dist/` drift is part of why the working tree feels unsalvageable.)
- **Adopt a "no fix without a failing test against the contract" rule** for this surface specifically. Tests must reference the contract document, not the current implementation. If the contract does not cover the case, update the contract first.
- **Limit the dispatch surface's blast radius in `action-common`.** Anything dispatch-specific belongs in this package; `action-common` should expose primitives (list checks, list statuses, create status, dispatch workflow) and nothing higher-level. The current cross-package edits are a symptom of that boundary being porous.

## Lessons

1. **"Get checks running" is not a task; it is a contract.** Eleven commits scoped as a task produced eleven partial answers. One commit scoped as a contract would have produced one answer.
2. **A green test suite is not evidence of a working feature when the tests grew up alongside the bug.** Tests need an external reference (a contract document, a consumer repo's behavior) to be trustworthy on a surface that has churned this much.
3. **`dist/` being committed makes iteration spirals more expensive.** Every in-progress source change drags a bundled artifact along with it, and the artifact is what real consumers run. The cost of leaving a working tree dirty is higher here than in a normal source repo.
4. **The right time to stop iterating is the moment the iteration stops converging.** That moment was probably around commit 5 or 6. We are documenting it now at commit 11 + an uncommitted diff.

## Postscript

This post-mortem is itself the first artifact in the recommended sequence above — a written acknowledgment that the current trajectory is not going to land. The next artifact should be the contract document, not another code change.
