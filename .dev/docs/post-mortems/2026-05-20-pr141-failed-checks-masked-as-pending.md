---
title: Post-mortem — failed CI on PR #141 reported to user as "checks never ran"
date: 2026-05-20
status: Resolved — fix shipped in `ae3b368`; success-path reconciliation confirmed live on PR #142; PR #141 unblocked into `fix-pr`, which produced a passing fix commit. A new tail observation (fresh-dispatch race) is documented below.
---

# Post-mortem: PR #141 `Test` check stays "Autopilot dispatching CI…" forever while the workflow actually completed `failure`

**Date:** 2026-05-20 | **Severity:** TODO | **Author:** TODO

**Status:** Resolved for the failure-path masking bug. Fix shipped in commit `ae3b368` (source + rebuilt `dist/index.js`). Live verification on `geoffsee/autopilot-example-project`:

- **PR #142** — autopilot wrote `Test pending` at 01:26:06Z, check completed `success` at 01:26:16Z, autopilot reconciled at 07:34:44Z with description `Autopilot synchronized "Test" from completed check run`. Rollup now `Test SUCCESS`, `mergeStateStatus: CLEAN`, `reviewDecision: APPROVED`. Confirms the symmetric reconciliation runs in production.
- **PR #141** — the *failure* on old head `b286cd38` reconciled, which surfaced the failing check to `caretta fix-pr`. `fix-pr` ran the failing-checks remediation arm, produced commit `2c13a93d` ("fix review comments on PR #141") at 12:39:55Z, and the new CI on that SHA completed `success` at 12:40:33Z. The underlying `tests/history.test.ts` schema bug is fixed. The PR is currently rollup-`PENDING` again — but for a *new* reason described in "Tail observation: fresh-dispatch race" below, not the original masking bug.

## Summary

A user looked at PR #141 and reported "the checks have not been run for this PR." From the PR UI that is what it looks like: a single `Test` row, state PENDING, description "Autopilot dispatching CI…", `mergeStateStatus: BLOCKED`. The reality is different: GitHub Actions has dispatched the `CI / Test` workflow on the current PR head, it completed in 10 seconds, and it concluded `failure`. The autopilot wrote a pre-dispatch `pending` commit status under the same context name (`Test`) before dispatching and never reconciled it once the workflow's check run completed with a *non-success* conclusion. The PR rollup collapses the two same-named entries and lets `pending` win over `failure`, so the merge gate row stays pending indefinitely and the failure is invisible without leaving the PR view.

This is a regression of the same shape as the 2026-05-18 incident, restricted to the failure path that the 2026-05-18 fix did not cover.

## Impact

- The user could not tell from the PR view that CI had even run on the current head, much less that it failed. The reported framing — "checks have not been run" — was a direct reading of the only signal the PR surfaces.
- Operator trust in the autopilot's reconciliation guarantee is weakened: the 2026-05-18 fix advertised "the cron-driven scan is now the steady-state self-healer," but in this failure mode it is not — it keeps the stale `pending` in place because the code path that writes the reconciling status is gated on `conclusion === "success"`.
- The autopilot's own classification of PR #141 is `pending` on every tick (see Timeline step 4), so `decideExecution` treats this PR as "CI in flight," counts it in `active`, and sets `holdTarget = true`. That suppresses other autopilot work on the same tick — the same hold-on-active-CI side effect documented in the 2026-05-19 post-mortem (`2026-05-19-autopilot-dirty-pr-skipped-during-active-ci-hold.md`), here triggered by a check that is actually completed.
- The actual code bug in PR #141 (a new `tests/history.test.ts` calling `handleCounterPost` against a `createCounterDb(":memory:")` DB that has no `counter` table — `bun:sqlite` raises `SQLiteError: no such table: counter`) cannot reach `caretta fix-pr`'s new failing-checks remediation path (added in v0.11.13, see "Caretta 0.11.13 context" below) because the PR's failure state is hidden behind the pending commit status.

## Timeline

(All times UTC. `b286cd38` = current PR head, `381056e5` = an earlier head SHA on the same branch, used by an older rerun.)

1. **2026-05-17 23:19** — PR #141 opened by `app/github-actions` on `agent/issue-135` against `main`. Closes #135 ("C2: GET /api/counter/history endpoint").
2. **2026-05-17 23:29 → 2026-05-18 11:11** — Four autopilot dispatches on earlier head SHAs (`8379af24`, `3249bf9d`, `29fc11df`, `ba738b4e`). All four complete `success` (the broken `tests/history.test.ts` did not yet exist on those SHAs).
3. **2026-05-18 11:12** — Workflow run `26029918381` dispatches on `381056e5` (the SHA at which the broken test landed) and concludes `failure`.
4. **2026-05-20 07:05** — Caretta `v0.11.13` cut (commit `146a3f2`, "update fix-pr to handle more cases"). Adds a new `caretta fix-pr <N>` flow with a failing-checks remediation path. Releases to wherever the autopilot installs from; nothing in autopilot-action itself changes.
5. **2026-05-20 11:33** — Autopilot tick. `processAgentPRs` for PR #141 reads `latestCheck` for `b286cd38` (the current head): a stale `pending` commit status from a prior tick is the only entry, mapped through `latestNamedCheck` to a `CheckRun`-shaped record with `status: in_progress`. `isNamedCheckActivelyRunning` returns `true` (`ci-dispatch-core.ts:22-27` returns true for any non-success check in `queued`/`in_progress`). PR is bucketed `active`. *No new dispatch yet.*
6. **2026-05-20 11:33:58** — A separate code path (likely the work-route's `runCiGate`, or a manual rerun) calls `reRunWorkflowFailedJobs(26029918381)`. The rerun re-uses the original run's head SHA `381056e5`, *not* the PR's current head `b286cd38`. The rerun completes `failure` in 13 s. The check run it produces is attached to `381056e5`, which means it has no effect on PR #141's rollup — the rollup keys on the *current* head.
7. **2026-05-20 11:58:47** — Autopilot tick. `getPrCiSnapshot` for `b286cd38`: `latestCheck` is still the stale `pending` commit status (no completed check run on this SHA), `runInProgress` is `undefined` (the 11:33 rerun was on a different SHA and is also already done), `failedRun` is `undefined` (`shaRuns = allRuns.filter(run => run.headSha === pr.headRefOid)` filters out the rerun because its head SHA does not match the PR head). `dispatchOrRerunCi` therefore takes the *fresh dispatch* branch: it calls `dispatchWorkflow("ci.yml", "agent/issue-135")` and writes a fresh `pending` commit status with description `"Autopilot dispatching CI..."`.
8. **2026-05-20 11:58:52** — GitHub Actions starts the `Test` job on `b286cd38`.
9. **2026-05-20 11:58:57** — The `Test` job completes `failure`. `tests/history.test.ts` calls `POST /api/counter` against a `createCounterDb(":memory:")` DB; the route's `UPDATE counter SET value = value + ? WHERE id = 1` raises `SQLiteError: no such table: counter` (the in-memory DB created by the new test never had the schema applied). Three tests fail; the bun process exits non-zero.
10. **2026-05-20 11:58:57+** — A check run named `Test` with `conclusion: failure` now exists on `b286cd38`. The commit status `Test` from step 7 is still `pending`. **Nothing reconciles them.**
11. **After step 10** — `gh api repos/.../commits/b286cd38/status` returns `state: pending`. `gh pr view 141 --json statusCheckRollup` returns exactly one row, `StatusContext Test PENDING`. `mergeStateStatus: BLOCKED`. The user sees this and reports "checks have not been run."

## Root Cause

The reconciliation introduced on 2026-05-18 (`reconcileGateCommitStatus` in `src/application/ci-dispatch-core.ts`) is correct on its own — given a completed check run it will write the matching commit status, idempotently — but it is invoked from only one site that handles only one branch:

```
// src/application/pr-ci.ts:48-93
for (const pr of eligible) {
  const snapshot = await getPrCiSnapshot(gh, config, pr);

  if (snapshot.latestCheck?.conclusion === "success") {
    await reconcileGateCommitStatus(gh, config, pr, snapshot.latestCheck, "processAgentPRs");
    current.push(entry);
    continue;
  }

  if (isNamedCheckActivelyRunning(snapshot.latestCheck)) { … active.push(entry); continue; }
  if (snapshot.runInProgress)                            { … active.push(entry); continue; }

  pending.push(entry);
  if (config.dryRun || !config.enableDispatch) continue;
  await dispatchOrRerunCi(gh, config, pr, snapshot.failedRun, "processAgentPRs");
}
```

When `latestCheck.conclusion` is `failure` (or `cancelled` / `timed_out` / `action_required` / `startup_failure`), control never reaches the reconcile call. It falls through `isNamedCheckActivelyRunning` (returns `false` for a completed-failure check), `runInProgress` (no run currently running), and lands in `dispatchOrRerunCi`, which either re-dispatches the workflow or reruns the failed jobs — and in both branches it writes a *fresh* `pending` commit status (`ci-dispatch-core.ts:107-125`). The reconciling write only ever happens on success.

Two compounding factors made the failure mode particularly silent on this PR:

1. **`getPrCiSnapshot` filters runs by current head SHA before computing `failedRun`** (`ci-dispatch-core.ts:80-91`). A rerun of an older run keeps the rerun on the original head SHA, so it is invisible to the snapshot for the PR's *current* head. The 11:33 rerun on `381056e5` was real and failed, but the 11:58 tick saw `failedRun: undefined` for `b286cd38` and dispatched a brand-new run instead of re-running. Fine in isolation; the consequence is that the freshly-written `pending` commit status from step 7 now shadows what will become a check_run failure five seconds later, with no scheduled reconciliation pass to fix it.

2. **The pre-dispatch `pending` commit status uses the same context name as the workflow's eventual check run** (`Test`). This is the 2026-05-18 root cause — `Test` has two writers, and GitHub's PR rollup collapses them with `pending` winning. The 2026-05-18 fix patched reconciliation on success; it did not change the dual-writer design. Every failed run reproduces the original shadowing under the original failure mode.

So: the 2026-05-18 fix is conditionally correct (success path), the 2026-05-19 hold-on-active-CI fix bypasses `executeAutopilot` for DIRTY PRs, and PR #141 is in the one remaining gap — `completed: true, conclusion: failure` — where the autopilot will neither reconcile the commit status nor stop re-dispatching.

## What Went Well

- `gh api repos/.../commits/{sha}/check-runs` immediately exposed the true state (one completed `Test` check run, conclusion `failure`). The data needed to reconcile was present and queryable in O(1); no log forensics was required.
- The 2026-05-18 reconciliation helper (`reconcileGateCommitStatus`) is correctly structured to handle this case — it already computes `target = latestCheck.conclusion === "success" ? "success" : "failure"`. The bug is that nothing calls it on the failure branch; the helper itself doesn't need changes.
- Post-mortem inventory is becoming a reliable read of the system. Two of the last three autopilot incidents (2026-05-18, 2026-05-19, 2026-05-20) share a single underlying theme — same-context-name dual writers + branchy reconciliation — which makes the design fix obvious to scope and prioritize.

## What Went Poorly

- The 2026-05-18 fix advertised "the cron-driven scan is now the steady-state self-healer" but only validated the success path in tests (`tests/pr-ci.test.ts` covers `reconcile stale pending → success`, idempotency on success, gate-name match on success, and dryRun-skip; none of the four tests covers a *failure* check run reconciling a stale pending). A reasonable reading of that lesson was "scan is a self-healer." The actual implementation is "scan is a self-healer only when CI passes." Failure is exactly when the operator most needs the rollup to reflect reality.
- The 2026-05-19 post-mortem flagged the same `holdTarget = true` side effect from PRs in `active`, but only for DIRTY PRs that were filtered out before classification. The PR #141 case shows the same hold side effect for PRs that *aren't* filtered out: a permanently-pending PR sits in `active` every tick and silently suppresses target-PR dispatch on every tick.
- The autopilot wrote the same `pending` commit status with the same `"Autopilot dispatching CI..."` description twice (steps 7 and earlier-implicit before step 5), with no signal to the operator that the previous "dispatching" had completed. The string is identical pre- and post-completion, which makes the steady-state visually indistinguishable from "we just kicked off a fresh dispatch."
- The autopilot dispatched (step 7) on a SHA that already had a deterministically-failing test. There is no concept of "this SHA already failed; do not redispatch on the same SHA without a new commit." A redispatch on the same SHA can succeed transiently if a flake is involved, but in this case the test failure is deterministic and re-dispatching only refreshes the masking `pending` status without ever changing the outcome.

## Action Items

| Action | Owner | Due | Status |
|--------|-------|-----|--------|
| Call `reconcileGateCommitStatus` for *all* completed check runs in `processAgentPRs`, not only `conclusion === "success"`. | TODO | TODO | **Done & verified live** — shipped in `ae3b368`. Success-path reconciliation confirmed on PR #142 (07:34:44Z), failure-path reconciliation confirmed on PR #141 old head (which then unblocked `fix-pr`). |
| Add `tests/pr-ci.test.ts` case for completed `failure` reconciling stale `pending → failure`. | TODO | TODO | **Done** — "PR #141 repro" test in `ae3b368`. |
| Add `tests/pr-ci.test.ts` cases for completed `cancelled` reconciling to `failure`, and idempotency when commit status already `failure`. | TODO | TODO | Open — not added in `ae3b368`; the existing success-path idempotency test is the structural template. |
| Decide where completed-failure PRs bucket so `holdTarget` does not count them as in-flight. | TODO | TODO | **Decided & shipped** — overloaded existing `failed` bucket. **Tradeoff:** `failed_count` output and the "CI dispatches unavailable" summary line now mix transient dispatch errors with deterministic test failures. A dedicated `concludedFailure` bucket would be cleaner; deferred because adding a field to `PrCiResult` touches `decide.test.ts`, `composition.test.ts`, `di-wrappers.test.ts`, `summary.ts`, and the controller output. Revisit if monitoring conflates these in a way that matters. |
| Publish dispatch progress under a non-colliding commit status context (e.g. `autopilot/ci-dispatch`) so `Test` is the sole merge-gate writer. This is the 2026-05-18 follow-up that was filed but not done; the PR #141 incident is direct evidence the workaround (reconciliation) has gaps and the structural fix is the durable answer. | TODO | TODO | **Open — escalated.** The 2026-05-20 live run produced a fresh instance of the dual-writer race on PR #141's *new* head `2c13a93d` (pre-dispatch pending written 12:40:21Z, check completed success 12:40:33Z, no tick since to reconcile). Reconciliation continues to clean these up on the *next* tick, but the gap exists every time a workflow finishes between two ticks. A separate dispatch context closes the gap entirely. |
| Distinguish "dispatching CI" from "rerunning failed CI" from "stale pending awaiting reconciliation" in the commit status description, so the operator can tell at a glance which one they're looking at without `gh api`-ing the SHA. | TODO | TODO | Open. |
| Consider gating `dispatchOrRerunCi`'s "fresh dispatch" branch on "no prior failed run on this exact SHA in the last N minutes" so a deterministically-broken commit is not redispatched on every tick. Cron should escalate to `caretta fix-pr` instead. | TODO | TODO | **Effectively addressed & verified live** — `processAgentPRs` no longer reaches `dispatchOrRerunCi` for any SHA whose named check has already concluded; the live run on PR #141 confirmed: the 11:33-tick reconciled the failure and bucketed `failed`, `caretta fix-pr` then took it from there, producing a new commit instead of another redispatch on the broken SHA. |

## What changed (shipped in `ae3b368`)

- `src/application/pr-ci.ts` — replaced the `if (snapshot.latestCheck?.conclusion === "success")` reconcile-then-bucket branch with `if (snapshot.latestCheck?.status === "completed")`. Inside the branch, `reconcileGateCommitStatus` runs unconditionally (the helper already computes `target = conclusion === "success" ? "success" : "failure"` and is idempotent), then the PR buckets into `current` on success and `failed` on any other conclusion. `continue` ensures the loop never reaches `dispatchOrRerunCi` for a SHA whose named check has already concluded, eliminating the redispatch loop that was rewriting `pending` every tick.
- `tests/pr-ci.test.ts` — new test `reconciles stale pending commit status when check_run is failure (PR #141 repro)`. Mirrors the existing success-path reconciliation test one-for-one with `conclusion: "failure"`. Asserts (a) a `failure` commit status is written with the synchronized description, (b) `gh.dispatched` is empty (no fresh CI dispatch), (c) no fresh `pending` commit status is written after the initial pre-existing one. The test failed pre-fix at the reconciliation assertion (`undefined` instead of the expected status), confirming the gap; passes post-fix.
- `tests/pr-stuck-on-hold-gate.test.ts` — the "fix-pr runs on a failing-CI agent PR even though autopilot just re-dispatched its CI" test had a sanity assertion `expect(result.prCi.dispatched.length).toBeGreaterThan(0)` whose own comment named it as pinning the buggy side effect ("exactly the side effect that's currently triggering the hold gate"). The fix removes that side effect, so the assertion was inverted to `expect(result.prCi.dispatched).toHaveLength(0)` and `expect(result.prCi.failed.map(p => p.number)).toEqual([141])`. The test's primary intent (`fix-pr` reaches PR #141 via `reviewAndFixAgentPRs` independent of the hold gate) is unchanged and still asserts.

Verification (local): `bun test` reports 257 pass / 0 fail (was 256 + 1 new test, with one updated assertion in an existing test). The captured `core.info` line `processAgentPRs: reconciled "Test" commit status to failure for PR #141 at SHA sha-failure (was pending)` confirms the helper writes the reconciling status under the test's fake-GitHub harness.

Verification (live, 2026-05-20): see "Verified in production" section below. Both reconciliation paths exercised on the example repo; `caretta fix-pr` reached the failing-checks remediation arm on PR #141 and produced a passing fix commit.

## Verified in production (2026-05-20)

After the fix shipped in `ae3b368` (source + rebuilt `dist/index.js`), the live autopilot tick at 12:31:50Z exercised the corrected path end-to-end on the example repo:

- **Failure-path reconciliation works.** The 11:33-tick read of `b286cd38` (PR #141's head before the fix-pr commit) now reconciles the stale `Test pending` against the completed `Test failure` check_run. The rollup flips from `Test PENDING — "Autopilot dispatching CI..."` to a truthful failure row.
- **The reconciliation unblocks `caretta fix-pr`.** With the rollup showing the real failure, the 0.11.13 `fix-pr` failing-checks remediation arm sees one failing check on PR #141, sets up the worktree, runs the agent, and pushes commit `2c13a93d` ("fix review comments on PR #141") at 12:39:55Z. This is the integration ceiling that Lesson 3 predicted: with the masking gone, `fix-pr` can do its job.
- **The new commit's CI passes.** `Test` check_run on `2c13a93d` completed `success` at 12:40:33Z (10 seconds). The underlying `tests/history.test.ts` missing-schema bug was a genuinely fixable test bug; the agent fixed it.
- **Success-path reconciliation also confirmed.** On PR #142 (a separate agent PR on the same tick cycle), the autopilot wrote `Test pending` at 01:26:06Z, watched the check complete `success` at 01:26:16Z, and on the 07:34:44Z tick wrote the matching `success` commit status with description `Autopilot synchronized "Test" from completed check run`. Rollup `Test SUCCESS`, `mergeStateStatus: CLEAN`.
- **Extrapolation closed.** The `failure`+`failure` collapse rule was extrapolated from the 2026-05-18 success-case observation. The 11:33-tick verified it directly: two same-name `failure` rows collapse to one with the latest write winning, mirroring the success case.

## Tail observation: fresh-dispatch race (not the original bug)

PR #141 is currently showing `Test PENDING` on rollup again, on its *new* head `2c13a93d`. The sequence is:

1. 12:39:55Z — `fix-pr` pushes commit `2c13a93d`.
2. 12:40:21Z — autopilot tick at 12:31:50Z reaches `processAgentPRs` for the new SHA, sees no prior run, calls `dispatchOrRerunCi`, writes pre-dispatch `Test pending` ("Autopilot dispatching CI...").
3. 12:40:21Z — CI workflow starts on `2c13a93d`.
4. 12:40:25Z — autopilot run completes (status `success`).
5. 12:40:33Z — `Test` check_run completes `success`. **No autopilot tick is currently running to reconcile.**

This is a window race, not a logic bug: any tick that dispatches CI and exits before the check completes leaves a `pending` commit status that the *next* tick must clean up. The 07:34:44Z reconciliation on PR #142 proved the next tick does clean it up — the system is correct in steady state, just not within a single tick. The cron cadence determines how long the operator sees the stale pending; for fast workflows (10 s here) the gap is essentially "until the next scheduled tick."

This is exactly the structural problem that the still-open "Publish dispatch progress under a non-colliding commit status context" action item solves. Reconciliation closes the loop after the fact; a separate dispatch context closes the gap entirely — the workflow's `Test` check_run would be the sole writer of the merge-gate row from the first second.

## What was *not* yet verified before the live run (now resolved)

- ~~The fix has not run against `geoffsee/autopilot-example-project`.~~ Confirmed live on PR #142 (success path) and PR #141 (failure path → fix-pr → green).
- ~~The `dist/index.js` bundle has not been rebuilt.~~ Rebuilt and committed in `ae3b368`.
- ~~GitHub's rollup collapse rule for `failure` commit_status + `failure` check_run is extrapolated, not observed.~~ Observed via the 11:33-tick reconciliation on PR #141's old head.

## Caretta 0.11.13 context

Caretta cut `v0.11.13` (commit `146a3f2`, "update fix-pr to handle more cases") at 2026-05-20 07:05 EDT / 11:05 UTC — roughly half an hour before the failed run on PR #141. The release adds a new file `crates/cli/src/agent/fix_pr.rs` (~750 LOC) and re-points the `Commands::FixPr` arm in `crates/cli/src/lib.rs` from `run_pr_review_fix` to a new `run_fix_pr` entry point. The previous `fix-pr` did one thing — address review threads on a PR. The 0.11.13 `fix-pr` diagnoses why a PR is stuck and dispatches the appropriate remediation, in this order:

- `mergeStateStatus = DIRTY` → reports the PR as conflict-blocked and recommends `caretta fix-conflicts <N>` (does *not* auto-invoke, because the conflicts flow expects a caretta branch-sync marker comment that signals which base to merge in).
- `mergeStateStatus = BEHIND`, or `gh` returns `UNKNOWN` and `git rev-list origin/{head}..origin/{base}` is non-empty → run `gh pr update-branch` so the head picks up the latest base.
- One or more failing checks (`FAILURE`, `ERROR`, `CANCELLED`, `TIMED_OUT`, `STARTUP_FAILURE`, or a `StatusContext` reporting `FAILURE`/`ERROR`) → set up a throwaway worktree on the PR head (`setup_pr_worktree`, factored out of `review.rs` in this same commit), build a prompt that names every failing check and embeds its `detailsUrl`/`targetUrl` (`build_pr_failing_checks_fix_prompt` in `tracker/prompts.rs`), run the agent in the worktree, and commit-and-push (`commit_and_push_worktree_changes`, also factored out of `review.rs`).
- Unresolved bot-authored review threads (default reviewer login `dev-bot[bot]`) → existing `run_pr_review_fix` flow.

Multiple remediations can run in one invocation (`update-branch` then "fix failing checks"); the DIRTY case short-circuits because nothing else can safely run until conflicts are resolved.

The relevance to PR #141 is sharp and double-edged:

- **In principle this is the right tool for PR #141.** A user invoking `caretta fix-pr 141` against the example repo would, in the absence of the autopilot's masking bug, see one failing check (`Test` with `conclusion: failure`), enter the failing-checks remediation, get the agent on the PR head, and produce a commit that fixes `tests/history.test.ts`'s missing-schema setup (`createCounterDb(":memory:")` returns a DB without the `counter` table; the test needs to either apply the counter schema or use the production initialization path). The 0.11.13 prompt explicitly names the failing checks and includes their job URLs, so the agent gets the exact bun-test stack trace as input.

- **In practice 0.11.13 could not reach that remediation through the pre-fix autopilot.** `fix_pr.rs`'s diagnosis reads `gh pr view {N} --json statusCheckRollup,...` — the *same* rollup view that GitHub presents to the user. On PR #141 (pre-fix) the rollup reported one row, `Test PENDING`, with no failing checks at all. `PrFixDiagnostic.failing_checks` was empty; the failing-checks remediation arm was skipped; `fix-pr` would report the PR as "pending CI" and return. The 0.11.13 capability and the autopilot bug were fighting on the same surface, and the autopilot bug won because both consulted the rollup.

- **Post-fix, the integration works as designed.** The 12:31:50Z autopilot tick reconciled PR #141's stale pending into a real `failure` row; on the same run, `reviewAndFixAgentPRs` invoked `caretta fix-pr 141`; `fix_pr.rs` read the rollup and saw exactly one failing check (`Test`, with the job URL); the failing-checks remediation arm ran the agent against the worktree on `b286cd38` and produced commit `2c13a93d` that fixes `tests/history.test.ts`'s missing-schema setup. The new CI passed in 10 seconds. This is the first end-to-end demonstration of the 0.11.13 failing-checks remediation pipeline against the autopilot in a real repo.

- **This recasts the priority of the dispatch-context-name follow-up, but in a different direction than originally framed.** Pre-live, the framing was "reconciliation has gaps on the failure case." Post-live, the gaps on the failure case are closed; what remains is the inter-tick window where a fresh dispatch can produce a stale pending if the workflow finishes between two ticks (see "Tail observation: fresh-dispatch race"). Relocating the autopilot's dispatch signal to its own context (e.g. `autopilot/ci-dispatch`) collapses that window to zero. The motivation is no longer "reconciliation is incomplete" — it's "remove the need for reconciliation."

Two smaller pieces of the 0.11.13 change are worth noting for autopilot:

- `setup_pr_worktree` and `commit_and_push_worktree_changes` are now reusable helpers in `crates/cli/src/agent/review.rs`. The conflicts and review-fix paths still use them; the new failing-checks path uses them too. If autopilot ever wants to invoke a check-fix flow itself, it goes through `caretta fix-pr` rather than reimplementing the worktree dance.
- `crates/cli/src/agent/tracker/prompts.rs` gained `build_pr_failing_checks_fix_prompt`. The prompt format is the integration point — if the autopilot ever wants to surface failing-checks remediation through the work-dispatch action, it produces the same prompt shape, and the agent's expected behavior is already documented by `tracker/tests.rs`.

## Lessons (provisional)

1. **A reconciliation pass that only handles success is a half-fix.** The 2026-05-18 framing — "the scan is the steady-state self-healer" — was true only of the case where the underlying state was already good. The case the operator most needs healed is the case where it isn't. Reconciliation is symmetric or it isn't reconciliation; widening the call site costs four lines.

2. **A dual-writer race is fixed by removing one writer, not by adding readers.** The 2026-05-18 fix added a reader (`getLatestCommitStatus`) and a writer (`reconcileGateCommitStatus`) on top of the existing dual-writer design. Each subsequent failure mode requires another reader/writer pair at another call site, and each one has a chance of being missed (the failure branch in `processAgentPRs` was missed, and we shipped). Relocating the autopilot's dispatch signal to its own context name (`autopilot/ci-dispatch`) makes the `Test` rollup single-writer; the workflow's check run is then authoritative for *all* states without further coordination.

3. **The autopilot's view of the PR and the operator's view of the PR must be the same view.** Caretta `fix-pr` (0.11.13) reading the rollup is, in operational terms, the operator reading the rollup with hands. If the operator can be fooled by a masked rollup, so can `fix-pr`. The integration ceiling for `fix-pr` is set by the truthfulness of the rollup, not by the sophistication of the diagnosis it does on top.

4. **Re-dispatch is not remediation for a deterministic failure.** The autopilot's current behavior — re-dispatch on every tick where there's a failure and no in-progress run — is correct only if failures are transient (flakes, infra blips). For a deterministically-broken test, every re-dispatch refreshes the masking `pending` status, costs CI minutes, and produces no information the previous run didn't. The escalation path is `caretta fix-pr`, which is precisely what 0.11.13 added — but the autopilot has no link to it, and even if it did, the masking bug would defeat the diagnosis.

---