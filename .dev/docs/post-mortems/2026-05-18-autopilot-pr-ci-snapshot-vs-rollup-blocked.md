---
title: Post-mortem — autopilot CI classification vs GitHub PR rollup mismatch
date: 2026-05-18
status: Resolved (same day)
---

# Post-mortem: autopilot reports CI as success while the PRs themselves stay BLOCKED

**Date:** 2026-05-18 | **Severity:** TODO | **Author:** TODO

**Status:** Resolved same day. The five live agent PRs (#141, #142, #143, #144, #145) will be cleared by the next autopilot run because reconciliation is idempotent and self-healing.

## Summary

The autopilot's per-PR scan was classifying agent PRs as `current` (CI successful, nothing to do) while GitHub's PR rollup was reporting the same PRs as `PENDING` and `mergeStateStatus: BLOCKED`. The autopilot was not wrong about what it read from the REST check-runs API — there really were green `Test` check_runs on those head SHAs — but the PRs were not, in fact, mergeable, because the autopilot's own pre-dispatch `pending` commit_status was still attached under the same gate name and was the only entry GitHub's PR rollup surfaced. The autopilot trusted a view that no other consumer (branch protection, the GitHub UI, humans) trusted, and reported "all good" while the queue silently stalled.

## Impact

- All five open agent PRs were stuck `BLOCKED` even though their dispatched workflows had passed (or, for #143, were being correctly re-run after failure).
- The cron-driven autopilot kept marking them as `current` and skipping any remediation — there is no other actor that would have noticed the divergence.
- Trust regression: the operator-facing classification (`current` / `pending` / `failed`) became unreliable. The user reported that the autopilot’s view of PR state did not match what they saw in GitHub for the same PRs (rollup / mergeability), which is accurate for the failure mode.

## Timeline

1. Autopilot scan picked up `agent/issue-139` at SHA `9ccc70f25…`. No `Test` check existed yet.
2. `dispatchOrRerunCi` (`ci-dispatch-core.ts`) called `dispatchWorkflow("ci.yml", "agent/issue-139")` and immediately wrote `createCommitStatus(sha, "pending", "Test", "Autopilot dispatching CI...")` as a visibility signal.
3. The dispatched workflow ran on the agent branch and finished `success`. GitHub Actions created a check_run named `Test` whose `check_suite.head_sha` matched the PR head.
4. On the next autopilot scan:
   - `GET /commits/{sha}/check-runs` returned the workflow's check_run: `Test`, `completed`, `success`.
   - `listCheckRuns` (`packages/action-common/src/github-client.ts`) shadowed the same-named commit_status by the check_run and returned the success entry.
   - `getPrCiSnapshot.latestCheck.conclusion === "success"` → `processAgentPRs` pushed the PR to `current` and moved on.
5. Meanwhile, `gh pr view 145` / GraphQL `statusCheckRollup` continued to report exactly one context: `StatusContext "Test" PENDING`, `mergeStateStatus: BLOCKED`. The commit_status the autopilot had written at step 2 was never updated, and GitHub's PR rollup collapses status + check_run sharing a context name into one row whose state is dominated by `pending`. The PR could not merge.

## Root Cause

Two structural conditions had to coincide:

1. **Two writers, one context.** The autopilot writes a `pending` commit_status under the same context name (`Test`) as the workflow's eventual check_run. After step 2, two independent producers each own a "Test" record on the same SHA, and there is no orchestrator updating the autopilot's record once the workflow finishes.

2. **Asymmetric reconciliation between APIs.** REST `/commits/{sha}/check-runs` returns the check_run as a distinct entity; GraphQL `statusCheckRollup` (and `gh pr checks`, and branch protection) collapse status_context + check_run by context name and let `pending` win over `success`. The autopilot's internal `listCheckRuns` mirrored REST's view (with same-name shadowing favouring the check_run); GitHub's PR view did the opposite. Whichever view you trusted, the other one disagreed.

The autopilot trusted itself. The PR rollup is what gated merging. They diverged silently.

## What Went Well

- TODO

## What Went Poorly

The 2026-05-17 convergence commit (`c7e0aa0`) closed four real gaps: branch regex flex, `"workflow / job"` check naming, dispatch idempotency, post-execute re-scan. None of them touched the *reconciliation gap* — that the pre-dispatch pending commit_status is never updated to match the workflow's eventual conclusion. The gap was invisible in tests because `FakeGitHub.listCheckRuns` did not implement production's same-name shadowing rule. With the fake, a manually written `pending` status appeared as a newer check_run entry and dominated `latestNamedCheck`'s sort, so tests could never construct the exact production divergence (check_run says success, commit_status says pending, PR rollup says pending). The test surface effectively guaranteed they agreed.

`runCiGate`'s existing sync block (`execute-autopilot.ts:362-380`) was almost the right idea applied at the wrong moment: it wrote a reconciling commit_status when the workflow_run was completed but the check_run was *not yet* completed. In production, by the time the autopilot polled again, the check_run had usually caught up, so the block's success case never fired — but its failure mode in the catch-up window also went unnoticed because the writes it produced were shadowed by the in_progress check_run on every subsequent iteration (silent over-writing, no rate-limit signal until much later).

## Action Items

| Action | Owner | Due |
|--------|-------|-----|
| Publish dispatch progress under a non-colliding commit status context (e.g. `autopilot/ci-dispatch`) so `Test` is the sole merge-gate writer (follow-up noted in Lessons). | TODO | TODO |
| TODO — additional tracked follow-ups from this incident, if any | TODO | TODO |

## What was changed (commit pending)

- `packages/action-common/src/github-client.ts` — `getLatestCommitStatus(sha, context)` added to `GitHubClient`. Uses `getCombinedStatusForRef` and the existing gate-name matcher to find the latest commit_status that would shadow under the same name. Returns `null` when none exists. The Octokit implementation is small; the value is that callers can now ask "is the autopilot's own record out of sync?" cheaply.
- `src/application/ci-dispatch-core.ts` — `reconcileGateCommitStatus(gh, config, pr, latestCheck, logPrefix)` helper. Reads the current commit_status, computes the target from the check_run's conclusion, writes only when they disagree. Idempotent under repeat invocation; honors `dryRun` and `enableDispatch`; logs reconciliations explicitly so post-incident audits can reconstruct what was synthesized vs. what GitHub Actions reported.
- `src/application/pr-ci.ts` — `processAgentPRs` calls the reconcile helper before classifying a PR as `current`. The cron-driven scan is now the steady-state self-healer: every time it observes a green `Test` check_run, it ensures the matching commit_status agrees so the PR rollup clears.
- `src/application/execute-autopilot.ts` — `runCiGate` (a) reconciles when its own observed check_run is completed (covers the in-flight work-dispatch path) and (b) the workflow-completion sync block now reads the existing commit_status and skips its write when it already matches the workflow conclusion. Without (b) the loop kept writing the same `success` status on every poll because the writes were shadowed and the visible state never changed.
- `tests/fakes.ts` — `FakeGitHub.listCheckRuns` now applies the same shadowing rule as production. This was the load-bearing test change: it made the production divergence representable in tests, and immediately surfaced that the existing `runCiGate` sync block was non-idempotent under shadowing. Added `getLatestCommitStatus` backed by `createdStatuses`.
- `tests/pr-ci.test.ts` — four scenarios: reconcile stale `pending` → `success`; no-op when the commit_status already matches (idempotency); `CI / Test` workflow check name matches the bare `Test` gate (gate-name reconciliation, not literal string equality); `dryRun` skips reconciliation.
- Stubs in `tests/composition.test.ts`, `tests/conflict-resolver.test.ts`, `tests/main.test.ts`, and `tests/behaviors/utils/main-harness.ts` got a `getLatestCommitStatus` no-op so the strict-mode interface stays satisfied.

Verification: `bun run typecheck` clean across `autopilot-action`, `work-dispatch-action`, `factory-cycle-action`; `bun run lint` reports nothing outside the unrelated `examples/autopilot-example-project` checkout; `bun test` 226 pass / 0 fail (was 222 pre-fix; +4 new tests covering reconciliation).

## Lessons

1. **When two API views of the same artifact disagree, prefer the one your users see.** The autopilot read `/commits/{sha}/check-runs` and built its world model on it; humans, branch protection, and `gh pr view` read the PR rollup. There is no rule that says these have to agree, and they don't agree for `workflow_dispatch`-induced check_runs + same-named commit_statuses. Picking the REST view internally is fine *only* if the autopilot also takes responsibility for making the PR rollup match — which it now does, by writing the reconciling commit_status.

2. **Don't write your own progress signal under the same context name you're waiting on.** The pre-dispatch `pending` commit_status named `Test` was a defensive UX choice that turned load-bearing in the failure mode: a transient visibility signal became a persistent gate. The reconciliation fix patches the symptom. A cleaner long-term move is to publish the dispatch signal under a non-colliding context (e.g. `autopilot/ci-dispatch`) so the workflow's `Test` check_run is the sole writer of the merge-gate row. Filed as a follow-up, not in this change.

3. **Test fakes that diverge from production hide exactly the bugs production has.** `FakeGitHub.listCheckRuns` did not implement same-name shadowing; that single gap made the entire divergence-of-views class of bugs structurally untestable. Bringing the fake into alignment with production immediately revealed a second bug (the non-idempotent sync write in `runCiGate`) that had been live the whole time. Fakes should err on the side of mirroring the production contract even when it makes tests harder to write — the alternative is tests that prove only that the fake works.

4. **Idempotency at the API level is not a nice-to-have when writes can be shadowed.** A `createCommitStatus` call that produces no visible state change (because something else with higher precedence shadows it) is indistinguishable from a successful update until you look at the rollup. Every poll under those conditions silently consumes rate limit. Always read-before-write when you can't observe the effect of the write.

5. **The user's framing was load-bearing.** Describing a **trust mismatch** (autopilot’s summary vs the operator’s view of the same PRs) is more useful than only saying “the check status is wrong” — it points at the trust-shaped problem instead of just the surface symptom. The fix was scoped to restoring agreement, not to defending the autopilot's previous view as technically correct.

---
*Blameless: this document examines systems and processes, not individuals.*
