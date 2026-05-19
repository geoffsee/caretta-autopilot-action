---
title: Post-mortem — DIRTY agent PR stuck behind another PR's active CI
date: 2026-05-19
status: Ongoing — fix landed locally, awaiting verification against the live example repo (PRs #141, #142)
---

# Post-mortem: DIRTY agent PR cannot get `fix-conflicts` called while another agent PR has active CI

**Date:** 2026-05-19
**Status:** Ongoing. Failing test written, root cause identified, fix implemented in the local tree (254/254 tests pass). Not yet observed clearing the actual stuck PRs on `geoffsee/autopilot-example-project` — that will happen on the next cron-driven autopilot tick after the fix is released.

## Summary

An agent opens a PR against `main` and the branch develops a merge conflict, so GitHub reports `mergeStateStatus: DIRTY`. Around the same time a *different* agent PR has CI in flight (`Test` check `PENDING`). When the autopilot ticks, `filterAgentPRs` drops the DIRTY PR before it ever enters the `pending / active / dispatched / current` buckets that `decideExecution` looks at. The pending-CI PR lands in `active`, which sets `holdTarget = true` and forces `targetDispatched = "skipped"`. Because `ConflictResolver` is only invoked from inside `executeAutopilot` (via `runWorkDispatch.fixConflicts()`), skipping execution means `fix-conflicts` is never called on the DIRTY PR — and every subsequent tick repeats the same hold, so the conflicting branch is permanently gated behind unrelated PRs' pending CI and never updates.

The user reported running autopilot several times against this exact state with no observed change:

- PR #142 (`agent/issue-136`): `mergeable=CONFLICTING`, `Test SUCCESS`, `REVIEW_REQUIRED`
- PR #141 (`agent/issue-135`): `mergeable=MERGEABLE`, `Test PENDING`, `APPROVED`

## Impact

- DIRTY agent PRs are silently stalled whenever any other agent PR has active CI. The window is effectively permanent in a busy repo because there is almost always *some* agent PR with a `Test` check in flight.
- Operator confusion: the autopilot reports `decision.targetDispatched: "skipped"` with `holdTarget: true` and no surfaced reason for the DIRTY PR's lack of progress. Nothing in the run summary mentions it because it was filtered out of `prCi` before classification.
- Knock-on: a tracker whose sprint includes the DIRTY PR cannot complete. `auto-merge --automerge-queue` will not advance the queue past a DIRTY entry, so any downstream PR that lands on the same tracker also stalls.

## Sequence (PR #142 as the worked example)

1. `agent/issue-136` opens PR #142 against `main` with a passing `Test` check. Some time later `main` advances and PR #142 develops a conflict — `mergeStateStatus` flips to `DIRTY`.
2. Around the same tick, an unrelated agent PR #141 (`agent/issue-135`) has a CI run in flight; its `Test` commit status is `PENDING`.
3. Cron fires `runAutopilot`:
   - `gh.listOpenPullRequests()` returns both PRs.
   - `processAgentPRs(gh, prs, config)` calls `filterAgentPRs(prs, pattern)` (`src/application/pr-ci.ts:18-24`), which drops any PR whose `mergeStateStatus === "DIRTY"`. PR #142 is now invisible to the rest of this tick.
   - PR #141's snapshot reports `latestCheck.status === "in_progress"` (`PENDING` commit status maps to `in_progress` in `listCheckRuns`); `isNamedCheckActivelyRunning` returns `true`; PR #141 is pushed onto `pending` and `active`.
4. `decideExecution(prCi, config)` (`src/domain/decide.ts:19-35`): `dispatched.length + active.length === 1` → `holdTarget = true` → returns `{ holdTarget: true, targetDispatched: "skipped" }`.
5. `executeAutopilot` is gated behind `decision.targetDispatched === "executed"` (`src/application/run-autopilot.ts`). It never runs. `ConflictResolver` is only constructed inside `runWorkDispatch.fixConflicts()` (`src/application/execute-autopilot.ts:246-261`), so it never runs either.
6. PR #142 stays DIRTY. The cron fires again. PR #141's CI is still pending (or by the time it isn't, a *new* PR has pending CI). Goto 3.

## Root cause

Two structural assumptions composed badly:

1. **`filterAgentPRs` treats DIRTY as "not eligible for any further action."** The filter at `src/application/pr-ci.ts:18-24` was written for CI dispatch — a DIRTY PR shouldn't get its CI re-run on a tip that can't merge. That's correct for CI. The implicit assumption was that *someone else* would handle the DIRTY case. Nothing does at the run-autopilot level; the DIRTY PR is simply absent from `prCi` and absent from the run summary.

2. **Conflict resolution lives inside the held branch.** `ConflictResolver` is constructed and run only from `CarettaRunner.fixConflicts` (`src/application/execute-autopilot.ts:246-261`), which is only reached via `runWorkDispatch`, which is only reached when `decision.targetDispatched === "executed"`. The hold rule was designed to avoid dispatching *new work* while CI is in flight on existing PRs — the right policy for `tracker-issue` dispatch, the wrong policy for conflict resolution, which doesn't dispatch new work and doesn't interfere with anybody else's CI.

The cron-driven scan is the steady-state self-healer for almost every other autopilot concern. For DIRTY PRs it was, by construction, never a healer at all: it filtered them out and then held its execution behind a condition the DIRTY PR couldn't influence.

## Why earlier iterations missed it

- The 2026-05-18 reconciliation work fixed a different "autopilot reports `current` while the rollup says BLOCKED" failure mode. It made the cron-driven scan self-healing for stale `pending` commit statuses, which trained the team to think of the scan as a self-healer in general. The DIRTY case is the one where that mental model is wrong: the scan can't heal what it can't see.
- Existing conflict-resolver tests covered the case where `executeAutopilot` runs and finds DIRTY PRs (the happy path inside `runWorkDispatch.fixConflicts`). No test exercised the path where `executeAutopilot` is *not* invoked because of a hold; that's where the gap lived.
- The `mergeStateStatus !== "DIRTY"` filter in `filterAgentPRs` looked locally defensible — there is no good outcome from dispatching CI on a DIRTY tip — so reading the code, the filter looked like the right behavior. The bug isn't in the filter; it's in the *absence of any pre-filter step* that handles conflict resolution.

## What changed (in the local tree; awaiting release)

- `src/application/execute-autopilot.ts`
  - Extracted the install + env + git-identity setup into a reusable `setupCarettaRuntime(config, deps)` helper so two callers (the existing `executeAutopilot` and the new pre-pass) can share runtime preparation without duplication.
  - Added `resolveDirtyAgentPRs(gh, exec, config, prs, deps)`: filters `prs` to non-draft agent PRs with `mergeStateStatus === "DIRTY"`, returns early when none exist or when `dryRun`/`!enableDispatch`, otherwise installs caretta and runs `ConflictResolver.withCaretta(...).resolveAll()`. Honors `deps.conflictResolverOptions` so tests can override timing. Returns `true` if caretta was invoked so the caller knows to re-fetch PR state.
- `src/application/run-autopilot.ts`
  - After `closeIssuesForMergedPrs` and the initial PR fetch, calls `resolveDirtyAgentPRs(gh, exec, config, initialPrs, executeDeps)` *before* `processAgentPRs` and `decideExecution`. If the resolver ran, re-lists PRs so downstream stages see the new tips that `fix-conflicts` pushed. Adds a code comment explaining why conflict resolution is allowed to bypass the hold: it doesn't dispatch new work and doesn't disturb other PRs' CI.
- `tests/dirty-pr-blocked-by-active-ci.test.ts` (new)
  - Constructs the exact reported state: one DIRTY agent PR with a green `Test`, one MERGEABLE agent PR with `Test` in flight. Pre-fix, the test failed: `exec.calls` contained no `fix-conflicts` invocation for #142. Post-fix it passes. Threads `conflictResolverOptions: { intervalMs: 0, maxAttemptsPerPr: 1 }` via `ExecuteDeps` so the resolver completes in <1s instead of sleeping the 30s default between attempts.

Verification (local): `bun test` reports 254 pass / 0 fail (was 253 + 1 new test). The fake `FakeExec` records the `fix-conflicts 142` call. The existing `executeAutopilot` work-route tests still pass because the resolver pre-pass is a no-op when no DIRTY PRs exist, and the work-route `fixConflicts` step inside `runWorkDispatch` is itself idempotent (running it twice in a single tick is harmless — the second call finds nothing to do).

## What is *not* yet verified

- **The fix has not run against `geoffsee/autopilot-example-project`.** PRs #141 and #142 are still in the state from the bug report. The next autopilot tick after this change is released should call `caretta fix-conflicts 142` against the live repo and push a merge/rebase commit; PR #142's `mergeStateStatus` should transition out of `DIRTY` on the *following* tick once GitHub recomputes mergeability.
- **GitHub's `mergeStateStatus` is asynchronous.** Even after a successful `fix-conflicts` push, the PR may still report `DIRTY` for one or more polls while GitHub recomputes. The fix tolerates this: `resolveDirtyAgentPRs` will simply find the same PR DIRTY on the next tick and re-run `fix-conflicts`, which is itself idempotent when there is nothing left to resolve. The `maxAttemptsPerPr` cap (default 2 per tick) prevents an infinite loop if `fix-conflicts` cannot actually unblock a PR; that PR will be left DIRTY and surfaced via the existing `core.warning` in `ConflictResolver.resolveAll`.
- **Cost: extra caretta installs per tick.** If there is any DIRTY agent PR, the autopilot now installs caretta and configures the runtime even when the work route would otherwise hold. The install is cached (`tool-cache`); the marginal cost is a few seconds per cron tick when DIRTY PRs exist. Acceptable; the alternative is the current state where DIRTY PRs never advance.

## Open follow-ups

1. **Surface DIRTY-but-filtered PRs in the run summary.** Today the run summary lists `pending / dispatched / active / current / failed`. DIRTY PRs touched by the resolver should appear in a `resolvedConflicts` bucket (or similar) so operators can see what the autopilot did about them. The bug went unnoticed in part because the summary was silent on the very PRs that were stuck.
2. **Reconsider `filterAgentPRs`'s DIRTY exclusion.** The filter exists to prevent CI dispatch on a DIRTY tip, which is still the right policy. But the filter is doing double duty as "make this PR invisible to the rest of the pipeline." Splitting those concerns — keep DIRTY PRs in the inventory, but tag them so CI dispatch skips them — would have prevented the entire class of "agent PR is invisible because of one attribute" bugs.
3. **Add a behavioral contract test** for "if there is a DIRTY agent PR, `fix-conflicts` is invoked on this tick regardless of other PRs' CI state." The new test in `tests/dirty-pr-blocked-by-active-ci.test.ts` proves the specific scenario; a contract-style test would prevent regression if someone later refactors the order of operations in `runAutopilot`.
4. **Verify against live state.** Once released, watch PR #142 across one or two autopilot ticks: confirm `fix-conflicts` lands a commit on `agent/issue-136`, `mergeStateStatus` transitions out of `DIRTY`, and PR #142 then re-enters the normal CI/review pipeline.

## Lessons (provisional, pending live verification)

1. **An exclusion filter is also a routing decision.** `filterAgentPRs` was written to answer "should we dispatch CI on this PR?" The answer was used as "should we look at this PR at all?" Those are not the same question. When a filter is reused, its meaning is implicitly broadened, and any handler that needed the filtered-out cases now silently has nothing to handle.
2. **Holds should be scoped to what they protect.** The hold-on-active-CI rule exists to avoid dispatching new tracker work while existing PRs are mid-CI. It accidentally also gated conflict resolution, which has no interaction with the thing the hold protects. Hold conditions should name the operations they suppress; a blanket "skip `executeAutopilot`" is too coarse when `executeAutopilot` does more than one kind of work.
3. **The cron is only a self-healer for things it can see.** The 2026-05-18 post-mortem leaned heavily on "the next scan will reconcile." That property is conditional on the PR remaining visible to the scan. When the scan filters out the cases that need healing, repeated runs become repeated no-ops — which is exactly the user's symptom ("I have ran the autopilot several times and these branches do not get updated"). Any new filter should answer: "if a PR matches this filter, what *does* heal it?"
