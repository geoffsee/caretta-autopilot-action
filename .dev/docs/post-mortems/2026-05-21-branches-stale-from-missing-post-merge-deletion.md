---
title: Post-mortem — `agent/issue-154` and `agent/issue-155` outlive their merged PRs because the autopilot has no branch-deletion call site; the latter directly caused the PR #162 wedge documented in 2026-05-21-stuck-prs-…
date: 2026-05-21
status: Diagnosed, contract surface still missing — `GitHubClient` does not expose `deleteBranch(ref)`, no code path attempts branch deletion, and no test can assert the behavior because the surface to assert against does not exist. The same gap was the lowest-numbered open action item in 2026-05-20-issues-not-closed-on-main-merge-trigger-duplicate-prs.md (§ "Add a `deleteBranch(ref)` method"). This is the second incident in three days where the same missing feature is load-bearing.
---

# Post-mortem: stale `agent/issue-*` branches on `geoffsee/autopilot-example-project` survive their merged PRs; the autopilot has no branch-deletion call site and no test surface to fail on

**Date:** 2026-05-21 | **Severity:** SEV-3 (no immediate data loss; latent because the next post-merge state always inherits the unrepaired remote, and at least one downstream incident is already caused) | **Author:** Claude / Geoff Seemueller

## Summary

`git ls-remote --heads` on `geoffsee/autopilot-example-project` reports six refs: `main`, `sprint-planning/2026-05-20`, and four `agent/issue-*` branches. Two of the four agent branches (`agent/issue-154`, `agent/issue-155`) are stale — their PRs merged 22+ hours ago on 2026-05-20 and the branches have no remaining purpose, but they still exist on the remote with their original head SHAs. The other two (`agent/issue-153`, `agent/issue-156`) back currently-open PRs and are legitimate.

The proximate cause is structural and well-documented: the autopilot has no `deleteBranch` call path. The `GitHubClient` interface (`packages/action-common/src/github-client.ts`) does not declare a branch-deletion method, the production `OctokitClient` does not implement one, and no code in `src/` or `packages/` invokes `gh api -X DELETE` against a ref. After a PR merges and `closeIssuesForMergedPrs` ticks the tracker and closes the issue, the agent branch is simply left in place. The repo also does not have GitHub's "automatically delete head branches" setting enabled, so the platform doesn't clean up either.

This is the same gap catalogued as the second action item in `2026-05-20-issues-not-closed-on-main-merge-trigger-duplicate-prs.md` and re-prioritized in `2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md`. The 2026-05-21 wedge (PRs #159 and #162 stuck for ~22 hours) is **causally downstream** of this gap: `agent/issue-155` surviving the squash-merge of PR #161 is what created the diverged base that broke PR #162's auto-retarget. If `agent/issue-155` had been deleted on 2026-05-20T14:41:19Z when PR #161 merged, PR #162 could never have ended up parented to a stale branch with no path back to `main`.

The question that surfaced this incident — "don't we have tests in place to ensure that issues are closed?" — conflates two invariants. Issue closure tests *do* exist and *do* enforce their contract (`tests/close-on-merge.test.ts` regression tests for sprint #140; `tests/run.test.ts` integration assertions). Branch deletion has no test because there is no contract surface to test: no interface method, no fake field, no production call site. A test for a feature that does not exist cannot fail; it cannot be written.

## Impact

- **Two leaked branches on the example repo right now**, with the following provenance and downstream cost:

| Branch | Tip SHA | PR | Merged at | Merge style | Downstream cost so far |
|--------|---------|----|-----------|-------------|------------------------|
| `agent/issue-154` | `2e51548…` | `#160` | 2026-05-20T14:41:09Z | regular merge into `agent/issue-153` | Inert — the work is already on `agent/issue-153` (PR `#159`'s head). When `#159` lands, `agent/issue-154`'s work lands as part of it. The branch occupies a remote ref and shows up in `git ls-remote` output, but doesn't otherwise interfere. |
| `agent/issue-155` | `3d17700…` | `#161` | 2026-05-20T14:41:19Z | **squash** into `main` (commit `275956c2…`) | **Load-bearing on the 2026-05-21 wedge.** PR `#162` was opened with base `agent/issue-155` while `#155` was in flight. After `#161`'s squash, `agent/issue-155`'s tip is no longer reachable from `main` (the squash created a new commit on `main` with different SHA). `agent/issue-155` vs `main` now diverges (2 ahead, 1 behind), so caretta's `gh pr edit 162 --base main` rejects the retarget ("unable to align base to 'main'"), and PR `#162` has been parked for 22+ hours. |

- **The class is larger than these two branches.** Across the post-mortem corpus, every closed-via-merge issue in the example repo's history left an `agent/issue-N` branch behind. Sprint #140's reconciliation on 2026-05-20 manually deleted four branches (`agent/issue-135`/`-137`/`-138`/`-139`) by hand via `gh api -X DELETE`; nothing automated has been added since. Each future sprint cycle ships ~3–6 sprint items, and each item will leak its branch under the current code unless an operator notices and intervenes.
- **Each leaked branch is a re-entry point for duplicate-PR loops.** The 2026-05-20 issues-not-closing post-mortem documented this specifically: `caretta issue --tracker N <issue>` works on the existing branch when it exists, so a future dispatch builds on top of the merged-and-stale tip rather than from `main`. The 2026-05-20 close-on-merge fix has broken that chain at the issue-state layer (tracker stays correctly ticked, so re-dispatch doesn't happen), but the *underlying branch persistence* that enabled the original duplicate-PR loop is still untreated. A different upstream regression — e.g., a future tracker drift, a transient gh failure dropping a closing-keyword reference — would put the loop back on the table for any issue whose branch still exists.
- **Stacked PRs are the worst case.** As demonstrated by PR `#162`, any stacked PR whose parent squash-merges into the default branch *and* whose parent branch is not deleted becomes a wedged PR. The damage is structural, not transient: a rebase + retarget + re-approval cycle is the only fix, and that's all manual operator work. The example repo's ruleset (`required_linear_history: true`, allowed merge methods `["squash", "rebase"]`) maximizes the surface area for this — every stacked PR's parent merge produces this state.
- **The gap is now blast-radius-multiplicative with the 2026-05-21 wedge.** The wedge's three stacked failures (caretta parser leak, autopilot automerge-queue gate, no retarget fallback) are individually defensible in isolation. The branch-cleanup gap is *prior* to all of them — it's the precondition that makes the other failures observable. If branches were deleted on merge, the empty-tracker-matrix wedge would have unstuck on its own once `#159` got auto-merge enabled, because there would be no `#162` to also worry about.

## Timeline

(All times UTC.)

1. **2026-05-20 14:41:09Z** — PR `#160` (head `agent/issue-154`, base `agent/issue-153`) merges via regular merge commit `7536922b…`. `closeIssuesForMergedPrs` ticks tracker `#157` for `#154` and closes the issue. **Branch `agent/issue-154` is not deleted.** No log line acknowledges the branch's existence.
2. **2026-05-20 14:41:19Z** — PR `#161` (head `agent/issue-155`, base `main`) merges via squash commit `275956c2…`. `closeIssuesForMergedPrs` ticks tracker `#157` for `#155` and closes the issue. **Branch `agent/issue-155` is not deleted.** No log line acknowledges the branch's existence. Note: `#161`'s squash mode is the load-bearing variable for the downstream PR `#162` wedge — under a merge-commit strategy the parent SHAs would still be reachable from `main` and a naive retarget would have worked even with the leaked branch present.
3. **2026-05-20 14:41 → 19:07Z** — Two scheduled autopilot ticks fire (15:19, 16:11 dispatch-triggered) and one pull_request-triggered tick. Each tick runs `dispatchMissingCi`, `runCiGate`, `resolveTrackerScopedPrs`, `caretta auto-merge --sync-branches`, etc. Each tick has full repo access (`contents: write`, `pull-requests: write`). **None of them delete `agent/issue-154` or `agent/issue-155`.** The capability is there; the call site is not.
4. **2026-05-20 19:07:36Z** — First wedged tick (run `26183993651`). `caretta auto-merge --sync-branches` walks the lineage, tries to retarget PR `#162` to `main`, fails because `agent/issue-155` has diverged from `main`. Logs `Giving up on PR #162 (#156): unable to align base to 'main'.` PR `#162` enters its parked state. *(This is the moment the branch-cleanup gap becomes load-bearing on a second post-mortem.)*
5. **2026-05-21 ~13:00Z** — Investigation for the 2026-05-21 wedge post-mortem inspects `git ls-remote --heads` and confirms four `agent/issue-*` branches present, two of which are stale.
6. **2026-05-21 13:48:24Z** — The autopilot's JS-side automerge gate fix ships (commit `bb83ccf` → `geoffsee/caretta-autopilot-action@main`).
7. **2026-05-21 ~14:00Z (now)** — Branch state on the remote is unchanged. `git ls-remote --heads` still reports `agent/issue-153`, `agent/issue-154`, `agent/issue-155`, `agent/issue-156`. The JS-direct auto-merge enable shipped in this session's final change set targets `#159` (default-branch base) and correctly skips `#162` (stacked base) — so even after the next tick, `agent/issue-155` will still be alive backing the parked stacked PR.

## Root cause

### 1. The contract surface for branch deletion does not exist

`packages/action-common/src/github-client.ts` declares the `GitHubClient` interface with 13 methods (counting `enableAutoMerge` added in this session). None deletes a ref. There is no `deleteBranch`, no `deleteRef`, no equivalent. The production `OctokitClient` correspondingly has no implementation. The fake (`tests/fakes.ts`) has no recording field for delete calls.

Three layers of "the surface does not exist":

- **No interface method to implement.** Anyone wanting to add branch deletion has to start by extending `GitHubClient`. That's the same shape as the `enableAutoMerge` addition in this session (5 LOC change including JSDoc).
- **No call site to wire to.** Branch deletion logically belongs in `closeIssuesForMergedPrs` (`src/application/close-on-merge.ts`) — every PR closed there is also the moment its `headRefName` becomes deletable (the PR is merged, the work is durably on some other ref). The function does not currently know it should delete anything.
- **No test to fail.** With no method on `GitHubClient` and no call site, there is no behavior to assert. Writing the test that would catch this regression literally requires the implementation to exist first, because `expect(gh.deletedRefs).toContain("agent/issue-N")` is a syntax error when `gh.deletedRefs` is not a defined property.

This is the categorical difference between the issue-closure tests (which exist and enforce their contract) and the branch-deletion tests (which can't exist because their substrate doesn't).

### 2. The repo's "Automatically delete head branches" GitHub setting is not enabled

`gh api repos/geoffsee/autopilot-example-project --jq '.delete_branch_on_merge'` returns `false`. GitHub's platform-level fallback for this case is the "Automatically delete head branches" setting (`delete_branch_on_merge` in the API). When enabled, GitHub itself deletes the PR's head branch a few seconds after merge. When disabled (the example repo's current state), the responsibility falls to whoever opened the PR — which for autopilot PRs is the autopilot itself.

This is the "if the autopilot won't delete branches and the platform won't either, who will?" trap. The answer for the example repo since 2026-05-15 has been "nobody" — every merged agent branch from every prior sprint is still on the remote unless an operator manually swept it (sprint #140's reconciliation deleted four; sprint #157's reconciliation hasn't happened yet and may not have to if the autopilot fix lands first).

### 3. The autopilot is the unique writer for agent branches and is structurally the right place to delete them

`agent/issue-*` branches are created by `caretta issue --tracker N <issue>` (invoked from `runWorkDispatch` step 2). They are written exclusively by the autopilot's identity. No human collaborator ever pushes to an `agent/issue-*` branch. The pattern matches the configured `agentBranchPattern` regex (`/^agent\/issue-[0-9]+(?:-.*)?$/`).

This is the cleanest possible substrate for a branch-cleanup policy: the autopilot is the unique writer, the naming pattern is regex-checkable, the precondition for deletion is "the PR with this branch as head has merged and the corresponding issue is closed," and the post-condition is observable via `gh api repos/.../branches/<ref>` returning 404.

The fact that this is the cleanest possible substrate for branch cleanup *and* that the autopilot is the structurally-correct owner *and* that the cleanup still isn't happening is the strongest evidence that this is a feature gap, not a process gap.

### How the gap cascades

```
PR merges into default branch (or stacked parent)
        ↓
close-on-merge closes the linked issue and ticks the tracker (works correctly post-2026-05-20 fix)
        ↓
[no branch-deletion call site] ← THIS POST-MORTEM
        ↓
agent/issue-N persists on the remote with a stale tip
        ↓
        ├──→ If issue N is dispatched again (tracker drift, transient gh failure, etc.):
        │       caretta issue reuses the stale branch
        │       → builds on top of merged tip
        │       → opens duplicate PR
        │       (2026-05-20-issues-not-closed-on-main-merge-trigger-duplicate-prs.md, sprint #140 incident)
        │
        └──→ If a different PR is opened with this branch as its base (stacked PR):
                parent later squash-merges
                → stacked PR's base diverges from main
                → caretta retarget fails
                → stacked PR wedges
                (2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md, sprint #157 incident)
```

Two distinct failure modes, same upstream gap. Either downstream consequence is independently bad; together they're the case for fixing the gap.

## Test-coverage gap

This section is unusual because the gap is *prior* to any test. The standard "the test exists but encodes the wrong invariant" shape from other post-mortems doesn't apply; there is no test, period. What can be said about the test layer:

- **`tests/close-on-merge.test.ts`** asserts that the right issues get closed and the right tracker boxes get ticked when PRs merge. It does **not** assert anything about the merged PR's head branch. Adding `expect(gh.deletedRefs).toContain("agent/issue-N")` to the existing "regression (sprint #140 / PRs #141–#146)" test would be one line if the recording field existed. It doesn't.
- **`tests/run.test.ts`** integration tests cover the full `runAutopilot` cycle including `closeOnMerge`. They assert on `closeOnMerge.closed`, `evaluation.openIssueCount`, etc. — they do not assert on branch state because there is no branch state to assert on.
- **`tests/fakes.ts`** `FakeGitHub` has 14 recording fields (`dispatched`, `closedIssues`, `updatedIssueBodies`, `reRunCalls`, `createdStatuses`, `enableAutoMergeCalls`, etc.). It does not have a `deletedRefs` field. Adding it is 5 LOC.

The contract test that would catch this regression looks approximately like:

```ts
test("post-close-on-merge, the merged PR's head branch is deleted", async () => {
  const mergedPR = makeMergedPR({
    number: 161,
    headRefName: "agent/issue-155",
    baseRefName: "main",
    body: "Closes #155",
  });
  const gh = new FakeGitHub({
    mergedPrs: [mergedPR],
    issues: [makeIssue({ number: 155 })],
  });

  await closeIssuesForMergedPrs(gh, { defaultBranch: "main", agentBranchPattern: /^agent\/issue-/ });

  expect(gh.deletedRefs).toContain("agent/issue-155");
});
```

This test is unwritable today. The smallest set of changes that lets it be written (and fail meaningfully against current `closeIssuesForMergedPrs`) is the implementation outlined in the action items below.

## What Went Well

- **The diagnosis was free.** `git ls-remote --heads | grep agent/issue-` against a repo with merged PRs is a one-line check that immediately surfaces the problem. The autopilot's own logs are silent about it — no warning, no info line, no metric — but the underlying state is fully queryable in O(1).
- **The blast radius is bounded by the agent-branch pattern.** Even if the eventual `deleteBranch` call site has a bug, it can only affect refs matching `/^agent\/issue-[0-9]+(?:-.*)?$/` (the configured `agentBranchPattern`). It cannot accidentally delete `main`, `sprint-planning/*`, or any human-authored branch. The naming convention is the safety rail.
- **The fix is small and well-understood.** The 2026-05-20 post-mortem already wrote the action item with the right shape ("best-effort, warn-and-continue on failure, gated on `pr.headRefName` matching the configured `agentBranchPattern`"). No new design work is needed — just the implementation.
- **A parallel design pattern just shipped successfully.** The `enableAutoMerge` addition from this session (interface method → octokit impl → fake recording field → call site → regression test) is the exact same shape. The same five-step recipe applies for `deleteBranch`. The session has already proven out the pattern on a sibling problem in the same codebase, the same day.
- **Detection is also easy to add as a defense-in-depth signal.** A `core.warning` at the top of every tick that runs `git ls-remote` (or the equivalent GitHub API call) and lists `agent/issue-N` branches whose linked issue is closed is ~10 LOC and would surface this regression at every tick rather than waiting for a downstream incident to expose it.

## What Went Poorly

- **An open action item has now caused two post-mortems.** The 2026-05-20 incident catalogued the gap and the 2026-05-20 reconciliation manually deleted four branches as a one-shot operator action. The action item to *automate* the deletion was filed as Open and stayed Open for 22 hours, during which the gap caused the 2026-05-21 stacked-PR wedge. The 2026-05-21 post-mortem re-prioritized the action item but still didn't ship it. This is now the third document filing the same Open status. Each document costs more to write than the action item costs to implement.
- **The gap was visible-but-silent for the entire interval.** Every autopilot tick between 2026-05-20T14:41 and now (~22 hours, ~5 ticks) ran against a remote that contained six branches when it should have contained four. No tick emitted a warning. No metric tracked the count. The only path by which the operator notices is asking the question explicitly, as in the user message that surfaced this post-mortem.
- **The downstream consequence of the gap is not obvious from looking at the gap alone.** Reading the 2026-05-20 issues-not-closing post-mortem's branch-cleanup action item in isolation, the worst-case interpretation is "extra refs accumulate on the remote, eventually we have to garbage-collect them." That sounds low-priority. What it doesn't surface is that a leaked branch is also a *re-entry point* (the duplicate-PR loop case) and a *stacked-base trap* (the PR #162 case). Both downstreams are SEV-3 incidents in their own right. The cleanup gap deserves to be prioritized as the precondition for two known failure modes, not as a housekeeping nicety.
- **The example repo's "delete branch on merge" setting is off and nobody has noticed.** This is the simplest possible mitigation — flipping one GitHub repo setting via `gh api -X PATCH repos/geoffsee/autopilot-example-project -f delete_branch_on_merge=true` — and it would handle every PR that targets `main` (i.e., `#159`, `#161`, future direct PRs). It wouldn't help stacked PRs that merge into a non-default base (`#160` merged into `agent/issue-153`; GitHub's auto-delete only fires on default-branch merges), but it would have prevented `agent/issue-155` from outliving PR `#161`, which is the load-bearing instance. This is a 30-second change with no autopilot code involved at all.

## Action Items

| Action | Owner | Due | Status |
|--------|-------|-----|--------|
| **(Immediate, code-free)** Flip `delete_branch_on_merge` to `true` on `geoffsee/autopilot-example-project` via `gh api -X PATCH repos/geoffsee/autopilot-example-project -f delete_branch_on_merge=true`. This is the lowest-cost mitigation and it covers all default-branch merges going forward. It does **not** cover stacked-PR merges into non-default bases (PR #160's shape), so the autopilot-side fix is still needed — but every future PR targeting `main` would be cleaned up by GitHub itself, eliminating the most common case (and the load-bearing one for stacked-PR wedges). | TODO | TODO | Open. |
| **(Code, structural fix)** Add `deleteBranch(ref: string): Promise<void>` to the `GitHubClient` interface. Implement on `OctokitClient` via `octokit.rest.git.deleteRef({ owner, repo, ref: "heads/<branch>" })`; catch 404 and 422 silently (branch already gone or non-existent — idempotent). Add `deletedRefs: string[]` to `FakeGitHub`. Same five-step shape as the `enableAutoMerge` change from 2026-05-21 (`bb83ccf`) — the recipe is proven. | TODO | TODO | Open since 2026-05-20-issues-not-closed-on-main-merge-trigger-duplicate-prs.md, re-prioritized by 2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md, now load-bearing for two known incidents. |
| **(Code, call site)** In `src/application/close-on-merge.ts`, after each `closeIssueWithComment` succeeds in `closeIssuesForMergedPrs`, call `gh.deleteBranch(pr.headRefName)` if `agentBranchPattern.test(pr.headRefName) === true`. Best-effort: `try`/`catch` the call, emit `core.warning` on failure, do not propagate the error (a leaked branch is bad but a thrown exception from close-on-merge is worse). Test in `tests/close-on-merge.test.ts`: add the contract assertion `expect(gh.deletedRefs).toContain("agent/issue-N")` to the existing sprint-#140 regression test and to the new "default-branch merge" test added on 2026-05-20. | TODO | TODO | Open. |
| **(Code, observability)** Add a tick-start "branch-cleanup audit" that runs once per tick and compares `git ls-remote --heads` (or `repos.listBranches`) against the open-issue and open-PR sets. For any `agent/issue-N` branch where issue N is closed AND no open PR has it as `headRefName` AND no open PR has it as `baseRefName`, emit `core.warning("Stale agent branch: <ref> (issue #N closed, no referring open PR). Will be deleted on next close-on-merge pass.")`. Once the structural fix above ships, this audit's expected steady state is "zero warnings"; any nonzero count is a signal that the close-on-merge call site is failing silently. | TODO | TODO | Open. |
| **(Live state, one-shot)** Manually delete `agent/issue-154` and `agent/issue-155` via `gh api -X DELETE repos/geoffsee/autopilot-example-project/git/refs/heads/agent/issue-154` (and `-155`). Important caveat for `agent/issue-155`: PR `#162` currently lists it as `baseRefName`, so deleting it before `#162` is rebased + retargeted will leave PR `#162` orphaned. Order of operations: (a) on a local clone, `git fetch && git checkout agent/issue-156 && git rebase main && git push --force-with-lease`, (b) `gh pr edit 162 --base main`, (c) re-request bot review (head SHA changed; `require_last_push_approval: true`), (d) only then delete `agent/issue-155`. `agent/issue-154` can be deleted immediately (no open PR references it). | TODO | TODO | Open. |
| **(Code, stacked-PR special case)** Add a `caretta`-side or `autopilot-action`-side automated rebase path for stacked PRs whose base was squashed away. Specifically, when caretta detects "unable to align base to '<trunk>'" in `auto_merge.rs:550-558`, instead of `continue`, attempt: `git fetch && git checkout <head> && git rebase <trunk> && git push --force-with-lease && gh pr edit <num> --base <trunk>`. Gated on the agent-branch pattern, gated on `require_last_push_approval` re-request, gated on dry-run mode. This is the only path that closes the stacked-PR wedge automatically. Without it, even with branch-cleanup automated, future PR `#162`-shapes will need manual intervention. Caveat: lives upstream of this package (parent `caretta` repo) — out of scope here unless we add the same rebase path on the autopilot side. | TODO | TODO | Open. Lower priority than the above; the branch-cleanup fix prevents the precondition for most stacked-PR wedges. |

## Lessons (provisional)

1. **A missing test surface is invisible to test-passing.** "All 264 tests pass" is true and meaningful for the contracts the tests cover. It says nothing about the contracts that have no test, because there is no failure mode to express. When the question is "are issues being closed?", the test suite has an answer ("yes, here are the assertions"). When the question is "are branches being deleted?", the test suite has no answer — not "no", but the absence of a question to interrogate. The right tool for surfacing this is *not* more tests; it's the contract surface itself (interface method, fake field, call site). Once those exist, the test that would have caught the regression becomes writable as a one-liner.

2. **Open action items decay into incident causes.** The branch-cleanup action item was filed at SEV-4 priority (housekeeping) in the 2026-05-20 post-mortem because the immediate damage was "extra refs on the remote." Twenty-two hours later it caused a SEV-3 wedge on a stacked PR, and twenty-two hours after that it caused this post-mortem. The same action item's blast radius has now triggered two follow-on incidents. *Item priority should be updated when downstream blast radius is observed*, not just when the original item was filed. The 2026-05-21 wedge post-mortem did re-prioritize it in writing; the priority change did not translate into action because the loop "write up the gap" → "do nothing about the gap until the next incident" → "write up the new incident citing the same gap" doesn't cost enough per iteration to break out of. A standing "action items that have caused N incidents must be implemented before the next post-mortem ships" rule would prevent the loop, but it would need to be enforced at the post-mortem-publishing layer.

3. **GitHub's platform-level settings are an underused mitigation surface.** `delete_branch_on_merge: true` is one repo-level setting that handles a large fraction of this incident's blast radius with zero code change. The example repo's setting is off — possibly historical (the repo was bootstrapped with defaults), possibly intentional (some workflows want the branch to persist after merge for audit). Whatever the reason, the autopilot's owner is also the example repo's owner, and the cost of flipping the setting is one `gh api` call. The reason it hasn't been flipped is that *nobody asked the question "is the platform doing this for us?"* The action-item review template for new repos and post-mortems should include a "what GitHub platform settings would have made this impossible?" prompt; for this one the answer is `delete_branch_on_merge`.

4. **Stacked PRs and squash-merge are a recurring source of structural wedges in this codebase.** Two incidents in three days. The deeper question — "should the autopilot use stacked PRs in a squash-merge-required repo at all?" — has not been asked in a post-mortem yet. The mechanical case for stacked PRs (parallel reviews, focused diffs) is solid in a merge-commit world; in a squash-merge world, every parent merge already creates a SHA divergence that requires rebase on every child, plus the branch-cleanup gap creates the wedge. A future incident review should consider whether the parallelism benefit of stacked PRs outweighs the cumulative cost of stacked-PR-recovery cycles, in this specific repo's ruleset configuration. The answer might be "yes, but turn on delete_branch_on_merge and ship the autorebase action item." Or it might be "no, switch the autopilot to serial dispatch for issues with `blocked by` relationships and accept the longer wall-clock time." Either is a coherent design choice; the *current* configuration (stacked PRs + squash-merge + no branch cleanup + no auto-rebase fallback) is the worst quadrant of the four.

5. **The test-vs-feature distinction is a place where the post-mortem template helps articulate scope.** The user question that surfaced this incident ("don't we have tests in place to ensure that issues are closed?") was answerable in two parts because the post-mortem corpus had already named the distinction in its action items. Without the prior 2026-05-20 post-mortem flagging "Add a `deleteBranch(ref)` method" as a separate concern from the close-on-merge fix, the natural answer would have been "yes, tests exist" — and the structural gap would have stayed invisible for another sprint cycle. The lesson is not that post-mortems should write themselves harder; it's that the *action items* in a post-mortem are the audit trail for "what didn't ship yet and why." Action items that stay Open across multiple post-mortems are themselves a signal that should be surfaced at the start of every tick (or every operator review session, or every quarterly retro), not just relitigated incident-by-incident.

---
*Blameless: this document examines systems and processes, not individuals.*
