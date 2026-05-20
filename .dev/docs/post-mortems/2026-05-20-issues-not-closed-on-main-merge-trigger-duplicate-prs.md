---
title: Post-mortem — bot-merged PRs do not auto-close their linked issues; autopilot re-implements already-merged work
date: 2026-05-20
status: Resolved & verified live — fix shipped in commit `2f01ad3` on `geoffsee/caretta-autopilot-action@main` (source + rebuilt `dist/index.js`). Production run `26165635897` (job `76968890837`) on `geoffsee/autopilot-example-project` exercised the corrected code path end-to-end: `close-on-merge` closed issue #136 against the default-branch merge of PR #142 with the new App-identity comment template, the tracker checklist auto-ticked, and `tracker-matrix` now returns 0 issues. Live state fully reconciled (issues #135/#136/#137/#138/#139 closed with back-link comments, tracker #140 ticked, duplicate PRs #147/#148/#149 closed, five `agent/issue-*` branches deleted). Branch-cleanup automation, pre-fix-duplicate-PR cleanup, pre-dispatch guard, and tracker-drift sweep remain open in Action Items.
---

# Post-mortem: Sprint #140 issues #135–#139 stay OPEN after their PRs merge into `main`, branches are never deleted, tracker checklist never ticks, and autopilot re-dispatches work that is already in `main`

**Date:** 2026-05-20 | **Severity:** TODO | **Author:** TODO

## Summary

Five sprint issues (`#135`–`#139` under tracker `#140`) were implemented by the autopilot via PRs `#141`, `#143`, `#144`, `#145`/`#146` against `main`. All five PRs merged successfully with `Closes #N` keywords in their body and a populated `closingIssuesReferences` GraphQL edge. None of the five linked issues closed. None of the five agent branches (`agent/issue-135`–`agent/issue-139`) were deleted. The tracker checklist in `#140` still shows every item as `- [ ]`. On the next scheduled tick, the autopilot consulted `caretta tracker-matrix #140`, found the unchecked items, and dispatched fresh work — producing duplicate PR `#146` (re-merging `#139`) on 2026-05-18, and producing the currently-open duplicate PRs `#147` (`#135`) and `#148` (`#137`) on 2026-05-20 at 12:58Z, a few minutes after PR `#141` merged.

The single line that gates the regression lives in `src/application/close-on-merge.ts:67-73`:

```ts
if (targetsDefault) {
  skipped.push({
    number: num,
    reason: `PR #${pr.number} targets default branch ${defaultBranch}; GitHub will close`,
  });
  continue;
}
```

The autopilot assumes GitHub auto-closes the linked issue whenever the merging PR targets the default branch. GitHub does *not* do that when the PR is opened **and** merged by `app/github-actions[bot]` (or any GitHub App identity without an associated user who has Triage permission). The bot identity that opens and merges autopilot PRs is exactly that case. The assumption is silently wrong, the autopilot skips closure, the tracker never ticks, and the work-loop reissues the same task on the next cron tick.

## Impact

- **Wasted work.** Three duplicate PRs observed: `#146` (issue `#139`, merged), `#147` (issue `#135`, open), `#148` (issue `#137`, open). Each duplicate burns CI minutes, agent compute, code-review, and a `fix-pr` pass. PR `#146` reached merge a second time on the same code; PRs `#147`/`#148` will too unless an operator intervenes.
- **False tracker state.** Tracker `#140`'s checklist still shows every sprint item as `- [ ]`. Anyone reading the tracker — including humans, the autopilot's own evaluation, and `caretta tracker-matrix` — believes nothing has shipped, even though all five items are in `main`.
- **Branch sprawl.** Five `agent/issue-*` branches remain on the remote pointing at merged tips. Each one is also a re-entry point: `caretta issue --tracker #140 <N>` operates on the existing branch when it exists, so the next dispatch builds on top of the merged-and-stale branch state rather than from `main`, producing the empty-diff "Merge branch 'main' into agent/issue-N" commits that show up in `#146`/`#147`'s history.
- **Hold-gate amplification.** Every duplicate PR enters the `processAgentPRs` rollup and is counted toward `holdTarget`. So one stuck duplicate suppresses target-PR dispatch on every tick — the same hold side effect catalogued in `2026-05-19-autopilot-dirty-pr-skipped-during-active-ci-hold.md` and `2026-05-20-pr141-failed-checks-masked-as-pending.md`, here amplified by the volume of duplicates the bug generates.
- **The autopilot looks broken to an operator.** The sprint dashboard shows five OPEN issues, zero ticked tracker items, and a stream of newly-opened agent PRs for issues the operator already saw merged. The reasonable read is "the autopilot is in a loop"; the actual read is "the autopilot's close-on-merge has a permission-aware gap it can't see past."

## Timeline

(All times UTC. PR identifiers are in `geoffsee/autopilot-example-project`.)

1. **2026-05-17 23:12** — Tracker issue `#140` opens with a five-item checklist for sprint issues `#135`–`#139`.
2. **2026-05-17 23:19 → 23:29** — Autopilot dispatches `caretta issue` for each of `#135`–`#139`. Five agent branches created (`agent/issue-135`–`agent/issue-139`). Five PRs opened: `#141` (closes `#135`), `#142` (closes `#136`), `#143` (closes `#137`), `#144` (closes `#138`), `#145` (closes `#139`). All target `main`. All have `closingIssuesReferences` populated by GitHub on PR creation.
3. **2026-05-18 10:51:54** — PR `#145` (issue `#139`) merges into `main`. Merged by `app/github-actions[bot]`. **Issue `#139` does NOT close** — no `closed` event appears on the issue's timeline; `gh issue view 139 --json state` returns `OPEN`. Branch `agent/issue-139` is not deleted.
4. **2026-05-18 10:55:09** — Autopilot tick fires (4 minutes after `#145` merged). `runAutopilot` lists open issues — `#139` is in the list. `closeIssuesForMergedPrs` examines `#145`, sees `baseRefName === "main"`, takes the `targetsDefault` skip branch in `selectCloseCandidates`, records a `skipped` entry, and returns `closed: []`. `domain.evaluate` enters the `work` route for tracker `#140`, calls `caretta tracker-matrix #140 --json`, which still reports `#139` as a pending item (the checklist still shows `- [ ]`). `caretta issue --tracker #140 139` runs on the existing `agent/issue-139` branch, merges `main` in (commit `0d35f111…`), and pushes. Autopilot opens duplicate PR `#146` for the same issue.
5. **2026-05-18 11:00 → 11:11** — PRs `#144` (`#138`) and `#143` (`#137`) merge into `main`. Same pattern: issues `#138`/`#137` do not close, branches stay, tracker stays at `- [ ]`.
6. **2026-05-18 13:37:44** — Duplicate PR `#146` merges. Issue `#139` *still* does not close (same bot-merge mechanic on the second merge).
7. **2026-05-20 12:52:46** — PR `#141` (issue `#135`) finally merges into `main`, after the `tests/history.test.ts` schema fix landed via the failure-path reconciliation chain documented in `2026-05-20-pr141-failed-checks-masked-as-pending.md`. Merged by `app/github-actions[bot]`. **Issue `#135` does NOT close.**
8. **2026-05-20 12:58:01** — Autopilot tick (~5 min after `#141` merged). `closeIssuesForMergedPrs` again skips on `targetsDefault`. `tracker-matrix #140` still emits `#135` (checklist unchanged). `caretta issue --tracker #140 135` runs on the existing `agent/issue-135` branch (whose tip is `2c13a93d…`, the fix-pr commit). Autopilot opens duplicate PR `#147`.
9. **2026-05-20 12:58:41** — Same cycle for `#137`: duplicate PR `#148` opens.
10. **2026-05-20 (now)** — `gh issue list` reports `#135`, `#136`, `#137`, `#138`, `#139` all OPEN. `git ls-remote --heads` reports `agent/issue-135` through `agent/issue-139` all present. `gh issue view 140` shows `- [ ]` for every sprint item. PRs `#147` and `#148` are OPEN against `main` with the merged work already on their head.

## Root Cause

Three independent failures compound:

### 1. The default-branch fast-path is unconditional

`selectCloseCandidates` (`src/application/close-on-merge.ts:60-83`) iterates merged PRs, and for any PR with `baseRefName === defaultBranch`, it appends a `skipped` entry with the literal reason `"GitHub will close"` and `continue`s — **without consulting `openIssueNumbers`**, which is the only state that would tell it whether GitHub actually closed the issue:

```ts
if (targetsDefault) {
  skipped.push({ number: num, reason: `… GitHub will close` });
  continue;
}
if (!openIssueNumbers.has(num)) {
  skipped.push({ number: num, reason: `issue #${num} is not open` });
  continue;
}
candidates.push({ pr, issueNumber: num });
```

The two checks should be in the opposite order. The autoritative ground truth — "is the linked issue *actually* open right now?" — is in the second check; if the issue is still open after a merge to default branch, that *is* the signal that GitHub's auto-close did not fire and the autopilot must do it itself. Reordering would make the function self-correcting.

The reason the original order was chosen (commit `77d734d`, 2026-05-16, "Add `close-on-merge` support for cleaning up issues referenced by merged PRs targeting non-default branches"): the feature was scoped to the stacked-PR case, where GitHub's closing-keyword automation provably cannot fire because the PR doesn't merge into the default branch. The author assumed the default-branch case was already handled by GitHub and did not need replay. That assumption is restated in code as the `targetsDefault` skip, in the test name "skips PRs that target the default branch (GitHub already closed them)", and in the inline comment block at the top of the file ("GitHub only auto-closes referenced issues when the merging PR targets the repo's default branch. The autopilot opens PRs against other agent branches (so they can stack), so we must replay the closing-keyword resolution ourselves").

### 2. GitHub does not auto-close on bot-authored, bot-merged PRs

GitHub's documented preconditions for closing-keyword auto-close are: the PR is on the default branch, the PR and issue are in the same repo, and the author of the linked issue is the author of the linked PR *or* the PR author has Triage/Write/Maintain/Admin permission in the repo. PRs opened by `app/github-actions[bot]` are authored by a GitHub App identity, not a user account, and they do not satisfy the user-permission predicate that GitHub's auto-close machinery checks. Concretely, on this repo:

- All five PRs (`#141`, `#143`–`#146`) have `"author":{"is_bot":true,"login":"app/github-actions"}`.
- All five PRs have `"mergedBy":{"is_bot":true,"login":"app/github-actions"}`.
- The example repo's `.github/workflows/autopilot.yml` declares `permissions: { issues: write, … }`, so the workflow token *can* close issues — but the workflow does not invoke an issue-close API call on merge; it relies on GitHub's automatic closing-keyword resolution, which does not fire for this author/merger combination.
- The `closingIssuesReferences` edge is populated on all five PRs (i.e. GitHub *did* parse the keyword and link the issue at PR-creation time). The link exists. What does not happen is the second step: turning the link into a close action on merge.
- The issue timelines show `cross-referenced` events for PR open/close and a `referenced` event at merge, but **no `closed` event**.

The autopilot's first-order signal — "PR merged to default with closing keyword" — does not imply "issue closed" under the GitHub-App author identity the autopilot uses. The mismatch is not loud (no error, no log), it is silent (an issue stays open, a branch stays around, a tracker box stays unticked).

### 3. There is no post-merge branch-cleanup path

`packages/action-common/src/github-client.ts:14-53` defines `GitHubClient` with no branch-deletion method. Grep across `src/`, `packages/`, and `tests/` for `deleteBranch`, `delete_branch`, or `deleteRef` returns zero hits. The autopilot does not delete agent branches after merge, does not call `git push --delete`, and does not invoke a GitHub setting that would do it (the example repo does not have "automatically delete head branches" enabled either — observable from the live state of the five `agent/issue-*` branches). On the next tick, `caretta issue --tracker N <issue>` checks out the existing branch and works on top of it, which is how PR `#147` ended up with its head pointing at the same `2c13a93d…` commit that was just merged via `#141`.

These three failures stack:

```
GitHub doesn't auto-close (#2)
        ↓
close-on-merge skips on default branch (#1)
        ↓
Issue stays open → tracker checklist stays unticked → tracker-matrix re-emits the issue
        ↓
Branch still exists (#3) → caretta issue reuses it → duplicate PR opens
        ↓
Duplicate PR merges → loops (only luck or operator intervention breaks it)
```

Any one of the three would be enough to break the chain. Reordering the two checks in `selectCloseCandidates` is the lowest-cost intervention and the one that makes the autopilot self-correcting regardless of why GitHub failed to auto-close.

## Test-coverage gap

Three layered gaps, each of which would have caught this if it existed.

### A. The unit test enshrines the broken assumption

`tests/close-on-merge.test.ts:80-97`:

```ts
test("skips PRs that target the default branch (GitHub already closed them)", () => {
  const mergedPrs = [
    makeMergedPR({ number: 50, body: "Closes #39", baseRefName: "main" }),
  ];
  const { candidates, skipped } = selectCloseCandidates(
    mergedPrs,
    new Set([39]),   // <-- issue #39 IS in the open set
    "main",
  );
  expect(candidates).toHaveLength(0);   // <-- yet we assert no candidate is produced
  expect(skipped).toHaveLength(1);
  expect(skipped[0].reason).toContain("default branch");
});
```

The test setup is exactly the production incident: a PR merged into `main` closing `#39`, and `#39` is in the open-issue set at the time of the post-merge scan (i.e. GitHub did not actually close it). The expected behavior in the test is to skip — but skip is what *causes* the regression. The test is internally consistent with the implementation; both are wrong together. There is no companion test that says "but if `openIssueNumbers.has(num)` after a default-branch merge, treat that as evidence GitHub didn't auto-close and produce a candidate."

Adding that companion test, with the existing `FakeGitHub` harness, is ~15 lines and would have failed against the current implementation, forcing the implementer to choose between the two checks or to make the order conditional on observed state.

### B. The integration test only exercises the non-default-branch path

`tests/run.test.ts:194-224` runs `runAutopilot` through the close-on-merge integration with `baseRefName: "agent/issue-36"` — i.e. a stacked PR. It asserts that `#40` is closed, the tracker is updated, and the evaluation's issue list shrinks. There is no companion test that sets `baseRefName: "main"` with the linked issue still in `gh.listOpenIssues()`'s return value and asserts the same outcomes. The integration test, in effect, is also written against the assumption that "default-branch merges close themselves." `tests/run.test.ts:226-239` does cover the "no merged PRs" no-op case, but that is also a path that does not exercise the bot-merged-to-default scenario.

### C. There is no test that exercises the duplicate-PR feedback loop

No test in `tests/`, `tests/behaviors/`, or `packages/work-dispatch-action/tests/` simulates a tick where the open-issue set contains an issue whose work is *already in `main` via a merged PR*. The expected behavior in that state is one of:

- the issue is closed by close-on-merge (the fix proposed in §A);
- *or* `caretta tracker-matrix` filters out issues whose work is merged (parent caretta repo, outside this package's surface, but worth mentioning);
- *or* the autopilot's pre-dispatch filter (e.g. `execute-autopilot.ts`) drops issues whose `agent/issue-N` branch points at a commit reachable from `origin/main`.

None of those defenses exist, and none of them are tested. The only invariant `runAutopilot` enforces about the open-issue set vs. the merged-PR set is the one in §A, which is currently inverted.

Beyond the close-on-merge surface, two adjacent gaps are worth surfacing because the same incident exposes them:

- **No branch-cleanup test surface.** There is no `deleteBranch` method on `GitHubClient`, no test that asserts a merged agent branch is deleted, and no test that asserts the autopilot's behavior when an agent branch points at a merged tip. The absence of the method is itself the absence of the test surface, but adding the test surface first (a contract test that says "after a merged-and-closed flow, the branch is gone") would scope and motivate the implementation.
- **No test that the tracker checklist is updated for issues GitHub closed (not the autopilot).** `updateTrackerChecklist` is only called inside `closeIssuesForMergedPrs` for the issues `closed` in this pass. If GitHub *did* close the issue (the path the current implementation assumes), nothing in autopilot-action ticks the tracker checkbox. That is currently masked by the bigger bug (GitHub isn't closing anything), but it is independently broken and untested.

## What Went Well

- The data needed to diagnose this was 100% queryable in O(few) `gh` calls. `gh pr view --json closingIssuesReferences,baseRefName,mergedBy,author` exposed both that the closing link existed and that the author/merger were the bot identity. `gh api repos/.../issues/N/timeline` confirmed the absence of a `closed` event. No log forensics or repo scraping was needed.
- The fix is small (line reorder in `selectCloseCandidates`) and the unit test that would prove it is one new `test()` block in `tests/close-on-merge.test.ts` using existing fakes.
- Pattern recognition across the post-mortem corpus is paying off. The 2026-05-18, 2026-05-19, 2026-05-20-pr141, and now 2026-05-20-this incidents share a common theme: the autopilot writes one half of a state transition and assumes the other half happens elsewhere (GitHub rollup updates, GitHub auto-close, GitHub branch deletion). When the "elsewhere" doesn't happen, there is no reconciliation pass that notices.
- The example repo's autopilot workflow already declares `issues: write` and `pull-requests: write`. There is no infra change required for the autopilot to issue a `PATCH /repos/.../issues/N { state: "closed" }` from the same workflow token; the close-on-merge code path already does exactly that for the non-default-branch case.

## What Went Poorly

- A test was written that encoded the wrong invariant ("targets default → skip, period") with a confident name ("GitHub already closed them"). The test passed, the implementation passed, the assumption never got questioned because the test name read like an explanation. A test whose name asserts an external system's behavior should either (a) prove that external behavior by observation, or (b) be reframed as "we trust GitHub here; if GitHub deviates, we have a bug." Neither was done.
- The close-on-merge feature shipped with a feature comment ("PRs to default branch are closed by GitHub") that is true *in the textbook case* and false *in the case the autopilot actually inhabits*. The textbook case is a human author. The autopilot author identity is a GitHub App. The closing-keyword automation has a documented permission predicate. None of this was checked before the feature shipped.
- There is no monitoring or alerting on "tracker checklist drift": tracker `#140` has been at five unticked items for three days while the work has been in `main` for two days. The autopilot's own evaluation reads the tracker, but does not compare the tracker's claimed state against the actual merged state of the linked issues. Such a check would surface as a `core.warning` and the regression would be loud instead of silent.
- The branch-deletion gap (§3) is not new and has been latent since the feature was first shipped; only this incident makes it operationally visible because the duplicate-PR loop *requires* the branch to still exist for `caretta issue` to reuse. Tightening branch cleanup is independent of the close-on-merge fix but is on the same incident's blast radius.
- PR `#146` merged on 2026-05-18, three days ago. It merged the same work twice into `main` (an empty-ish merge on top of the already-merged tree). Nothing in the autopilot's evaluation noticed that the second merge added no functional change. A no-op merge is a strong signal of a duplicate-PR situation, and there is no detection for it.

## Action Items

| Action | Owner | Due | Status |
|--------|-------|-----|--------|
| In `selectCloseCandidates`, reorder the two checks so the `openIssueNumbers` membership test runs *before* the `targetsDefault` skip. If the issue is still open after a merge — regardless of base branch — produce a candidate. The skip's stated reason ("GitHub will close") becomes vacuously true: if GitHub *did* close it, the issue won't be in `openIssueNumbers` and the existing `not open` skip catches it. | TODO | TODO | **Done & verified live** — shipped in `2f01ad3` (source + rebuilt `dist/index.js`). The `targetsDefault` skip was removed outright; `openIssueNumbers` is now the sole gate. `_defaultBranch` is retained on the signature for the back-link comment in `closeIssuesForMergedPrs`, which now names the App-identity reason when `pr.baseRefName === defaultBranch` and the non-default-base reason otherwise. Live exercised on run `26165635897` job `76968890837`: log line `closed issue #136 (merged via PR #142)` at 13:27:50Z confirms the corrected code path produced a candidate for a default-branch merge whose linked issue was still in `openIssueNumbers`. |
| Add `tests/close-on-merge.test.ts` case "default-branch merge with linked issue still open → produces a close candidate (regression: GitHub does not auto-close PRs authored/merged by GitHub Apps)". One unit test that fails against the current code and passes after the reorder. | TODO | TODO | **Done** — new `selectCloseCandidates` test ("regression (sprint #140 / PRs #141–#146)") uses the live fixture (PR `#145` → `Closes #139`, `#139` in open set) and asserts a candidate is produced. Confirmed failing pre-fix (`expected length: 1, received: 0` at the `targetsDefault` skip); passing post-fix. |
| Add `tests/run.test.ts` integration case for the same shape: `mergedPrs` with `baseRefName: "main"` and `issues` containing the linked issue → asserts `closeOnMerge.closed` includes the issue, asserts the tracker checklist ticks, asserts `evaluation.openIssueCount` excludes the now-closed issue. | TODO | TODO | Open — not added in this pass. The unit-level regression test in `tests/close-on-merge.test.ts` exercises the same code path; an integration assertion in `tests/run.test.ts` still belongs in the suite for defense in depth. |
| Once the close-on-merge fix lands, reconcile the live state on the example repo: close issues `#135`–`#139` with back-link comments to the merging PRs, tick the five checklist boxes on `#140`, close the duplicate open PRs `#147` and `#148`, and delete the five `agent/issue-1{35..39}` branches. (The autopilot itself, with the fix shipped and a tick, will do the first three; the branch deletion needs the next action item.) | TODO | TODO | **Done — split between autopilot and operator.** Manual `gh` reconciliation on 2026-05-20 (pre-fix) closed `#135`/`#137`/`#138`/`#139` with back-link comments, ticked four of five checklist boxes on `#140`, closed duplicate PRs `#147`/`#148`, and deleted four `agent/issue-*` branches. Issue `#136` and PR `#142` were intentionally left in flight at that time. Post-fix, the autopilot itself closed `#136` and ticked its checklist box during run `26165635897` (verified live, see §Verified in production above); the duplicate PR `#149` (opened by the last pre-fix tick during the merge/fix race window) and its branch `agent/issue-136` were closed/deleted by hand on 2026-05-20 13:38Z. Final state: zero open sprint PRs, zero open sprint issues, zero remote `agent/issue-*` branches. |
| Auto-close pre-fix duplicate PRs when the linked issue is now closed via a *different* merged PR (i.e. a duplicate whose branch contributes a no-op delta against `main`). Without this, every pre-fix duplicate consumes ~$0.10–$0.13 of claude usage per `fix-conflicts` attempt before `resolveDirtyAgentPRs` warns and gives up — observed on run `26165635897` where PR `#149` cost ~$0.37 across three retries before the operator closed it by hand. | TODO | TODO | **New, surfaced by live verification.** The existing close-on-merge fix prevents *future* duplicates (`tracker-matrix` returns 0 because the tracker is now correctly ticked), but cannot recognize a pre-existing duplicate PR as a duplicate. Possible signal: when iterating open agent PRs, if `pr.headRefName` matches `agent/issue-N` and issue `#N` is in `closeOnMerge.closed` for *this* tick, the PR is a duplicate of whichever merged PR closed the issue and should be closed with a back-link comment + branch deletion. Defer until the "Add a `deleteBranch(ref)`" action item ships since they share the call site. |
| Add a `deleteBranch(ref)` method to `GitHubClient` and a post-close-on-merge call site that deletes the agent branch for each successfully closed issue. The call should be best-effort (warn-and-continue on failure) and gated on `pr.headRefName` matching the configured `agentBranchPattern` to avoid deleting non-agent branches. Add unit tests for the new method on the fake and a contract test that asserts the branch is deleted after a successful close-on-merge pass. | TODO | TODO | Open. The manual `gh api -X DELETE refs/heads/agent/issue-N` calls used on 2026-05-20 are the operation the autopilot needs to invoke after each successful close-on-merge candidate. |
| Add a defensive pre-dispatch check in `execute-autopilot.ts` (or in `caretta issue` upstream, whichever owns the branch-creation step): if the existing `agent/issue-N` branch tip is reachable from `origin/main`, do not dispatch new work on the issue; emit a `core.warning` like "issue #N appears merged (branch tip in main); skipping dispatch and queuing for close-on-merge". This is the belt-and-suspenders complement to the close-on-merge fix: if for any reason the close-on-merge pass hasn't run yet (or has been broken for another reason), this prevents the duplicate-PR loop. | TODO | TODO | Open. |
| Add a tracker-drift check: after `closeIssuesForMergedPrs` runs, scan the active tracker's checklist for items whose linked issue is closed and not yet ticked, and tick them. This covers the case where GitHub *did* close the issue (so `closed` is empty for that issue in `closeIssuesForMergedPrs`) but the tracker is stale anyway — currently masked by the bigger bug, but independently broken. | TODO | TODO | Open. |
| Update the documentation block at the top of `src/application/close-on-merge.ts` to reflect the actual GitHub semantics ("GitHub does not auto-close PRs authored or merged by GitHub Apps even when they target the default branch — we replay the closing-keyword resolution unconditionally and rely on `openIssueNumbers` to short-circuit the no-op case"). The current comment is the artifact of the wrong assumption and will mislead the next reader. | TODO | TODO | **Done (local)** — `selectCloseCandidates` docstring rewritten to name the GitHub-App-identity case as the reason `openIssueNumbers` is the sole authority. The file-level comment block at the top of `close-on-merge.ts` is unchanged but is now consistent with the function it documents. Not yet released. |
| Rename the misleading existing test "skips PRs that target the default branch (GitHub already closed them)" to something that matches the new (corrected) semantics, e.g. "skips PRs whose linked issue is no longer in the open-issue set, regardless of base branch". The current name explains a system behavior; the new name explains a function precondition. | TODO | TODO | **Done** — renamed to "default-branch merge whose linked issue GitHub already closed is skipped as 'not open' (issue dropped from openIssueNumbers)" and the setup was inverted (empty `openIssueNumbers` instead of `{39}`) so the test exercises the human-author / GitHub-already-closed path rather than the broken assumption. A companion test in `closeIssuesForMergedPrs` ("does NOT close issues referenced by PRs targeting the default branch") was likewise rewritten as the sprint-#140 regression case and a sibling no-op-when-GitHub-closed test. |

## Manual state correction (2026-05-20)

The five-item sprint scope of the regression was refined during reconciliation: only four of the five sprint issues had their PRs actually merged into `main`. `#136`'s PR `#142` is still open as the in-progress original (not a duplicate), so it does not belong to the regression's blast radius and was intentionally left untouched. The autopilot will continue working `#136` through `#142` normally.

The remaining four issues, two duplicate PRs, and four agent branches were reconciled by hand via `gh` CLI on 2026-05-20. All operations were performed against `geoffsee/autopilot-example-project`.

### Duplicate PRs closed

`gh pr close <N> --delete-branch=false --comment <…>` was used so the branch deletion could be ordered explicitly after the PR close (the close-comment also doubles as the audit trail that links the duplicate to its original):

- **PR `#147`** (closes `#135`, branch `agent/issue-135`) — closed with a back-link to PR `#141` (merged 2026-05-20T12:52:46Z). Comment names the GitHub App identity as the auto-close failure mode and points at this post-mortem's path.
- **PR `#148`** (closes `#137`, branch `agent/issue-137`) — closed with a back-link to PR `#143` (merged 2026-05-18T11:11:41Z). Same comment template.

### Issues closed (with back-link comments)

For each issue, an `issues:write` `comment` was posted first, then `gh issue close --reason completed` was invoked, so the closure event is preceded by the explanation in the timeline. Each comment names the merging PR with its full URL, the merge timestamp, the GitHub-App-identity auto-close failure mode, and the post-mortem path. This is the same comment shape the now-fixed `closeIssuesForMergedPrs` would write:

- **Issue `#135`** — comment links PR `#141` (merged 2026-05-20T12:52:46Z); closed `completed`.
- **Issue `#137`** — comment links PR `#143` (merged 2026-05-18T11:11:41Z); closed `completed`.
- **Issue `#138`** — comment links PR `#144` (merged 2026-05-18T11:00:41Z); closed `completed`.
- **Issue `#139`** — comment links PR `#145` (merged 2026-05-18T10:51:54Z) and notes duplicate PR `#146` (merged 2026-05-18T13:37:44Z) as a downstream consequence; closed `completed`.

### Tracker `#140` updated

`gh issue edit 140 --body-file /tmp/tracker-140-body.md` replaced the body with a version that:

- Ticks `- [x]` for `#135`, `#137`, `#138`, `#139` in the Checklist section.
- Flips the four corresponding rows in the Task Dependency Hierarchy table from `🔴 Not Started` to `🟢 Shipped (#PR)` with the merging PR number.
- Leaves `#136`'s row at `🔴 Not Started` (it is the only sprint item still legitimately in-flight; PR `#142` is its open original).
- Appends a footer paragraph documenting that the checklist was reconciled by hand on 2026-05-20 and pointing at this post-mortem path.

### Branches deleted

The four `agent/issue-*` branches whose work is merged-and-stale were deleted via `gh api -X DELETE repos/.../git/refs/heads/agent/issue-N`. The fifth branch was intentionally retained:

- **Deleted:** `agent/issue-135`, `agent/issue-137`, `agent/issue-138`, `agent/issue-139`. Each branch's tip was reachable from `origin/main` via its merging PR's merge commit, so the deletion lost no work.
- **Retained:** `agent/issue-136`. Backing the open PR `#142`; deletion would orphan an in-progress PR.

### Final-state verification

Immediately after the mutations, `gh issue list --state open`, `gh pr list --state open`, `git ls-remote --heads`, and `gh issue view 140 --json body -q .body | grep -E "^- \["` were run together and produced the expected, consistent state:

- Open issues in the sprint scope: only `#136` (the in-flight item).
- Open PRs in the sprint scope: only `#142` (the open original for `#136`).
- Remote `agent/issue-*` branches: only `agent/issue-136`.
- Tracker `#140` checklist: `- [x]` for `#135`, `#137`, `#138`, `#139`; `- [ ]` for `#136`.

The reconciliation is idempotent against a re-run of the fixed `closeIssuesForMergedPrs`: every closed issue has been removed from `openIssueNumbers`, so the function takes the `"not open"` skip branch for each on the next tick. No further state correction is required from the autopilot side.

### What this does *not* fix

- The bug itself is fixed only in the local checkout; nothing has been pushed, packaged, or released. The deployed autopilot still has the broken `targetsDefault` skip and will reproduce the regression on the next sprint cycle if `#136`'s eventual PR merges before the new bundle ships. Releasing the fix is the next step the operator should take. *(Update: superseded — see "Verified in production" below; the fix was committed and pushed as `2f01ad3` at 13:20:43Z and exercised live on the next autopilot tick.)*
- The manual close-comment text differs slightly from what the autopilot will write post-fix (it explicitly names the GitHub App identity reason, whereas the autopilot's text now conditionally names "GitHub App identity" for default-branch merges and "the PR targeted X rather than Y" for stacked merges). The two phrasings are equivalent in intent; the difference is only visible if a reader compares the manual-comments timeline entries against the autopilot's after a future merge.
- Branch deletion is still not automated. The four `gh api -X DELETE` calls are the exact operation the still-open "Add a `deleteBranch(ref)` method to `GitHubClient`" action item needs to invoke.

## Verified in production (run 26165635897 / job 76968890837, 2026-05-20)

After the fix shipped in `2f01ad3` (source + rebuilt `dist/index.js`, pushed to `geoffsee/caretta-autopilot-action@main` at 13:20:43Z), a live autopilot tick on `geoffsee/autopilot-example-project` exercised the corrected path end-to-end. The full sequence:

1. **2026-05-20 13:20:11Z** — PR `#142` (issue `#136`, branch `agent/issue-136`) merged into `main` by `app/github-actions[bot]`. As expected, GitHub did not auto-close `#136` (the App-identity restriction documented in §2 of Root Cause).
2. **2026-05-20 13:20:43Z** — Fix commit `2f01ad3` pushed to `geoffsee/caretta-autopilot-action@main`.
3. **2026-05-20 13:23:38–42Z** — The `pull_request: types: [closed]` event from step 1 fired a workflow run that resolved `@main` to whatever HEAD it could see at workflow-start. That tick used the *pre-fix* bundle (it ran for ~3 minutes; the fix push at 13:20:43Z either narrowly missed or was outraced by the scheduled checkout). The buggy `close-on-merge` skipped issue `#136` under the `targetsDefault` branch, `tracker-matrix` re-emitted `#136`, and `caretta issue` reused the still-alive `agent/issue-136` branch to push commit `d01b0cb…` and open duplicate PR `#149` against `main`. One last copy of the regression.
4. **2026-05-20 13:27:38Z** — Operator manually dispatched run `26165635897` (job `76968890837`) to test the deployed fix.
5. **2026-05-20 13:27:44Z** — `Set up job` logs `Download action repository 'geoffsee/caretta-autopilot-action@main' (SHA:2f01ad375f01fecb9e30ed85a737f3bdfac8c8f7)`. The action checkout resolved to the fix commit. Confirmed `@main` reference.
6. **2026-05-20 13:27:50Z** — Autopilot logged `closed issue #136 (merged via PR #142)`. The new `selectCloseCandidates` consulted `openIssueNumbers` first, saw `#136` was still open after a default-branch merge, and produced a candidate — the exact path the pre-fix code took the `targetsDefault` skip for. The back-link comment posted to `#136` reads, verbatim:
   > Closed by merged PR https://github.com/geoffsee/autopilot-example-project/pull/142 (#142).
   >
   > Auto-closed by autopilot because GitHub's closing-keyword automation did not fire (the PR was authored or merged by a GitHub App identity).
   That is the `pr.baseRefName === defaultBranch` branch of the new comment template in `closeIssuesForMergedPrs`, observed live. Issue `#136` transitioned to `state: CLOSED`, `stateReason: COMPLETED`.
7. **2026-05-20 13:27:51Z** — Autopilot logged `updated tracker #140 checklist for 1 closed issue(s)`. Tracker `#140`'s Checklist section now shows `- [x] #136`. The `updateTrackerChecklist` path runs whenever a candidate is closed; this was the first time it has been exercised on a default-branch merge.
8. **2026-05-20 13:27:52Z** — `resolveDirtyAgentPRs: 1 DIRTY agent PR(s) detected: #149`. The pre-fix duplicate PR opened in step 3 is still in the repo state because the fix only addresses *future* duplicates (via close-on-merge ticking the tracker so `tracker-matrix` stops emitting the issue), not pre-existing ones.
9. **2026-05-20 13:28:22 → 13:32:35Z** — Three rounds of `caretta fix-conflicts 149` ran (~$0.37 in claude usage total: $0.13344, $0.12155, $0.11846). Each round: agent successfully resolves the conflicts in the worktree, reports "Both tests pass", then `caretta` logs `Conflict-resolution run made no file changes for PR #149` and the PR remains DIRTY. The "no file changes" outcome is correct: PR `#149`'s branch already matches `main` (the duplicate work was the same code as the merged work), so resolving the textual conflict produces a no-op delta. Final log line: `##[warning]resolveDirtyAgentPRs left 1 PR(s) DIRTY after retries: 149`.
10. **2026-05-20 13:31:19Z** — `Starting work dispatch for #140` → `Found 0 issues in tracker matrix.` The tracker is now correct (`#136` ticked, others ticked from the earlier manual reconciliation), so the work dispatch loop produces zero candidate issues. **The duplicate-PR feedback loop is closed at the source** — no further `caretta issue --tracker #140 N` invocations will fire for any of the five sprint items.
11. **2026-05-20 13:33:47Z** — Job completed `success`. Total runtime 6:09; the autopilot step itself ran 5:60 (a typical full-cycle time for this repo).
12. **2026-05-20 (post-run manual cleanup)** — PR `#149` closed by hand with a back-link comment to `#142` and the fix commit; branch `agent/issue-136` deleted via `gh api -X DELETE`. Final state: zero open sprint PRs, zero open sprint issues (`#135`–`#139` all closed), zero `agent/issue-*` branches on the remote.

### Production verdict

- **Close-on-merge regression: fixed and exercised on a real default-branch merge.** The exact code path that was previously taking the `targetsDefault` skip is now producing a candidate, closing the issue with the correct App-identity comment, and ticking the tracker. The "would have caught it" unit and integration tests (renamed/added in `tests/close-on-merge.test.ts`) now correspond to a production-observed behavior, not just a hypothetical regression.
- **Tracker drift: auto-corrected through the existing `updateTrackerChecklist` path.** No new tracker-drift sweep is required for this specific regression; the wider gap (when GitHub *did* close the issue and our close-on-merge skips with `"not open"`) is still untreated and remains an open action item.
- **Future duplicates: prevented at the source.** `tracker-matrix` now returns 0 for `#140`, so no fresh duplicate-PR loop can start for the five shipped items.
- **Pre-fix in-flight duplicate: leaked compute, then required manual close.** PR `#149` consumed three rounds of `fix-conflicts` (~$0.37) before the autopilot gave up and warned `resolveDirtyAgentPRs left 1 PR(s) DIRTY after retries`. The autopilot has no path to recognize "this PR is a duplicate of a merged one and should be closed, not retried" — that is the still-open "Add a defensive pre-dispatch check" and "auto-close duplicate PRs whose branch matches a merged sibling" gap. Until then, every operator-noticed duplicate from a pre-fix tick needs manual `gh pr close` + branch delete.
- **The race window between merge and fix-deploy was the one-shot vehicle for the last duplicate.** Steps 1→3 above describe the inter-tick window: a merge can land while the deployed action bundle is still pre-fix. After the fix is on `@main`, the window closes for new merges, but any PR opened by a tick that started before the fix bundle was downloaded by the runner will land as a leftover duplicate. There is no automated cleanup for these; only the next-tick `close-on-merge` write to the issue + the operator's manual triage of the stuck PR.

## Lessons (provisional)

1. **A test that asserts a downstream system's behavior is not testing your code; it is testing your beliefs about the downstream system.** "GitHub will close" is not a property of `selectCloseCandidates`; it is an assumption *consumed* by `selectCloseCandidates`. The test as written passes whenever the function honors the assumption, not whenever the assumption is correct. The right shape for a test against an external assumption is to either prove the assumption from observed external state (live test, not a unit test) or to invert it — write the function so the assumption is *never load-bearing* and have the test exercise the case where the assumption is violated.

2. **GitHub App identity is a permission boundary, not a labeling convenience.** The autopilot's bot identity is the right tool for opening and merging PRs (no human in the loop, audit trail, scoped token), but every GitHub feature that gates on "user with Triage permission" is a feature the App identity silently does not get. Closing-keyword auto-close is one. There are others (issue assignments, project-board automation triggers, reviewer-suggestion algorithms). A standing check ought to be: for every GitHub feature the autopilot relies on, list the actor identity the feature evaluates and verify the bot identity satisfies it. The places where it doesn't are where the autopilot needs to replay the behavior itself.

3. **A skip without proof is a wrong answer dressed as a non-answer.** `selectCloseCandidates` doesn't *say* "the issue is closed"; it says "I am skipping this." That phrasing reads as conservative. But operationally, "skip" means "do not close," which means "rely on someone else to close." If no one else is going to, "skip" is the same as "close = no" with a different label. Conservative code is code that *verifies* the skip condition (does the issue exist in the open set?) before invoking it.

4. **Three small failures stack into one operational regression.** The close-on-merge skip, the branch persistence, and the missing pre-dispatch check are each individually defensible (or at least small). Together they are the duplicate-PR loop. Post-mortems for system failures should always include the "what would have broken the chain" enumeration: any one of the three would have stopped the loop, and the cheapest of the three (reorder two if-blocks) is the closest to a fix.

5. **The autopilot needs an idempotency contract.** The pattern across the recent post-mortems (`2026-05-18`, `2026-05-19`, `2026-05-20-pr141`, this one) is: the autopilot performs an action whose intended effect doesn't materialize, has no reconciliation pass to detect that, and re-performs the action on the next tick. A first-class "did this previous action's intended state actually happen?" check, run at the top of every tick against every action the previous tick logged, would generalize the success-path reconciliations that have been bolted on one-at-a-time and turn each "X didn't happen" failure into a loud warning instead of a silent loop. That is a larger design change than this incident warrants, but each incident keeps pointing at it.

---
*Blameless: this document examines systems and processes, not individuals.*