---
title: Post-mortem — PRs #159 and #162 wedged for ~22 hours because tracker-matrix returns 0, autopilot mis-logs auto-merge as enabled, and #162's squash-merged base branch cannot be retargeted
date: 2026-05-21
status: Partial fix shipped, wedge NOT cleared. Commit `d5e1b40` on `geoffsee/caretta-autopilot-action@main` decoupled the §2 automerge gate from `tracker-matrix` (the `queuedPrs` filter now falls back to "all agent PRs" when `issueStringsAfterFix` is empty) and added a direct `enablePullRequestAutoMerge` call with a §3 safety skip for stacked PRs. Verified live in run `26231855013` (job `77194174209`, workflow_dispatch, 2026-05-21 14:19Z): the new path fires on both PRs, correctly skips PR #162 (`base 'agent/issue-155' is not the default branch 'main'`), and attempts to enable auto-merge on PR #159 — but GitHub's `enablePullRequestAutoMerge` mutation rejects #159 with `Pull request Pull request is in clean status` because the PR has no pending conditions to wait on (all checks green, approved, branch up-to-date). The direct-enable path has no fallback to `mergePullRequest`, so #159 stays wedged. The run then dies on a transient GitHub HTML 5xx ("Unicorn!" page) after `dispatchMissingCi`, marking the job as `failure` for the first time in the wedge sequence — but no state change. Net: both PRs still OPEN, MERGEABLE, CLEAN, `autoMergeRequest: null`. The §1 upstream `caretta` parser bug is still unfixed (`Found 0 issues in tracker matrix.` and `auto-merge (lineage): nothing scheduled after deterministic ordering filtered to open PR rows.` continue to fire), and the §3 stacked-base divergence on #162 remains. New defect surfaced: `enableAutoMerge` is a no-op against the most-ready PRs because GitHub's mutation requires at least one pending gate.
---

# Post-mortem: PRs #159 (`agent/issue-153`) and #162 (`agent/issue-156`) sit `APPROVED + MERGEABLE + CLEAN + Test:SUCCESS` for ~22 hours with auto-merge never enabled; every autopilot tick logs "all tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue." while the GraphQL API reports `autoMergeRequest: null` on both

**Date:** 2026-05-21 | **Severity:** SEV-3 (work in flight is stuck but no data loss; the autopilot keeps running but produces no forward motion) | **Author:** Claude / Geoff Seemueller

## Summary

Two open agent PRs on `geoffsee/autopilot-example-project` — PR `#159` (head `agent/issue-153`, base `main`) and PR `#162` (head `agent/issue-156`, base `agent/issue-155`) — have been parked in the same state since 2026-05-20 ~19:07Z: each has an APPROVED bot review on the current head SHA, a green `Test` check on the current head SHA, `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`, and `autoMergeRequest: null`. The default-branch ruleset's only required check is `Test`, and `Test` is green on both. Nothing is blocking the merge except the absence of auto-merge being turned on (PR #162 has the additional problem that its base branch was squash-merged into `main` and not deleted; retargeting to `main` fails).

Three defects stack to produce the wedge:

1. **The `caretta` tracker parser treats `(blocked by #X)` inside an `[x]` checklist line as evidence that issue `#X` is also completed.** Tracker `#157`'s checklist has `- [x] #154 F4: Prometheus /metrics endpoint (blocked by #153)` (etc.), so `parse_completed` returns `{153, 154, 155, 156}`. `parse_pending` then prunes `#153` (the actual unchecked item) because it's already in `completed`. `tracker-matrix #157 --json` returns `[]`.
2. **The autopilot's `runWorkDispatch` gates the automerge-queue invocation on `issueStringsAfterFix.length > 0`**, where `issueStringsAfterFix = issues.map(String)` and `issues` is the (now empty) tracker-matrix output. With `issues = []`, the filtered `queuedPrs` is unconditionally empty and `needsAutomerge = [].some(...) = false`, so the autopilot skips `auto-merge --automerge-queue` and logs the misleading "All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue." message even though the live GraphQL state is `autoMergeRequest: null` on both PRs.
3. **PR #162's base branch `agent/issue-155` still exists post-merge of PR #161 (squash-merged into `main` on 2026-05-20T14:41:19Z) and has diverged from `main` (2 ahead, 1 behind).** `caretta auto-merge --sync-branches --tracker 157` tries to retarget `#162` to `main` and fails with `Giving up on PR #162 (#156): unable to align base to 'main'.` (preceded by a `GraphQL: Something went wrong while executing your query` line — likely a transient on top of an already-malformed retarget attempt). There is no fallback path; the PR stays parented to a stale base. The branch-cleanup gap that left `agent/issue-155` alive after `#161` merged is the still-open action item from `2026-05-20-issues-not-closed-on-main-merge-trigger-duplicate-prs.md` (§ "Add a `deleteBranch(ref)` method to `GitHubClient`").

Each tick since 2026-05-20T19:07Z reproduces the identical log sequence: `Found 0 issues in tracker matrix.` → `Retargeting PR #162 to merge into 'main'… Giving up on PR #162 (#156)` → `Skipping PR #159: already reviewed …` → `Skipping PR #162: already reviewed …` → `All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue.`. Five scheduled/dispatched runs between 19:07Z and 12:50Z the next day have produced byte-identical no-op output and zero state change.

## Impact

- **Sprint #157 is stuck at 0 shipped items for the autopilot's purposes.** Two of the four sprint issues (`#154`, `#155`) have already shipped (PRs `#160` and `#161` are merged into `main`), but the sprint *tracker* checklist mistakenly shows all four as `[x]`, so the autopilot's evaluation reads "sprint complete" and dispatches no further work even though `#153` and `#156` are genuinely open with PRs ready to merge. The two open PRs are doing the right work; the autopilot just won't push them over the line.
- **PR `#159` is the easiest case and is the most embarrassing.** Branch ruleset compliance: 1 approving review on the head SHA (`caretta-ai[bot]` @ `1e516668…`), `Test` SUCCESS on the head SHA, `mergeStateStatus: CLEAN`, no review-thread resolution outstanding, `require_last_push_approval` satisfied, allowed merge methods include squash. A human clicking "merge" would merge it instantly. The only barrier is that `auto-merge` was never enabled by the autopilot.
- **PR `#162` is wedged behind a stacked-base failure** in addition to the missing auto-merge enablement. Its base ref is `agent/issue-155`, which got squash-merged into `main` via PR `#161` on 2026-05-20T14:41Z. The squash created a brand-new commit on `main` with a different SHA than the branch tip (3d177001…), so `agent/issue-155` shares no commits with `main`'s history past the original divergence point (2 ahead, 1 behind). `gh pr update-branch` can't fast-forward `agent/issue-156` onto `main` because the diff would include the squashed-and-renamed `agent/issue-155` work as net-new changes against `main`. `caretta`'s retarget code refuses and gives up; nothing else tries to repair the stack.
- **Compute is being burned on a no-op cron.** Five scheduled ticks (19:07Z, 01:21Z, 07:36Z, plus two `workflow_dispatch` runs at 16:11Z and 12:50Z) and at least one operator-triggered run have all produced identical log output. Each run downloads the caretta binary (~10s), provisions the workflow PEM, runs `tracker-matrix`, `auto-merge --sync-branches`, `dispatchMissingCi`, and the CI gate. The runtime is ~80–100s per tick and zero state changes. At a cron-every-6h cadence that is ~$0.05–0.10 of unnecessary minutes per day plus the autopilot dist download bandwidth, which is not the headline cost but is the visible signal that the loop is misbehaving.
- **The misleading log line "All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue." actively misdirects diagnosis.** The natural read of that line is "the auto-merge flag is set; we're waiting on something else (CI, review, base divergence)." The actual semantics is "the queued set is empty so we have nothing to check." If the next operator to look at this trusted the log line they would chase phantom auto-merge state in GitHub or a ruleset issue rather than the tracker-parser regression upstream.
- **Tracker `#157` will continue to display incorrect "Status" markers in the dependency-table section** (`🔴 Not Started` for `#154` and `#155`, both of which shipped two days ago). The same parser leak that broke `tracker-matrix` is upstream of the autopilot's own `updateTrackerChecklist` write path (which uses a different mechanism — `mark_completed` — and won't fix the table). Anyone — operator or `tracker-matrix` — reading the tracker gets a wrong picture.

## Timeline

(All times UTC. PRs and runs are in `geoffsee/autopilot-example-project`; the action source is `geoffsee/caretta-autopilot-action@main`.)

1. **2026-05-20 14:11–14:26Z** — Sprint `#157` opens (tracker). Four sprint items dispatched: `#153`, `#154`, `#155`, `#156`. Four agent branches created. PRs `#158` (later closed), `#159` (`#153`), `#160` (`#154`), `#161` (`#155`), `#162` (`#156`) opened. PR `#162` is opened against base `agent/issue-155` (intentional — `#156` depends on `#155`, so it's a stacked PR while `#155` is in flight). PRs `#159` and `#160` are opened against `main` directly.
2. **2026-05-20 ~14:41Z** — PR `#161` (`#155` → `main`) merges via squash. Branch `agent/issue-155` is **not** deleted (no branch cleanup automation; the post-mortem on 2026-05-20 catalogues this as a still-open action item). PR `#162`'s base ref remains `agent/issue-155`, now pointing at an orphaned branch whose tip is `3d177001…` and which has no commits in common with `main`'s post-squash history.
3. **2026-05-20 ~14:52Z** — PR `#160` (`#154` → `main`) merges. The autopilot's `closeIssuesForMergedPrs` ticks the tracker checklist for `#154` and `#155` (and also `#156` — see step 4). Branch `agent/issue-154` is **not** deleted.
4. **2026-05-20 14:18:05 → 16:24:08Z** — Code-review and fix-pr loop on PR `#159`: four reviews submitted by `caretta-ai[bot]`, three `CHANGES_REQUESTED`, the last `APPROVED` against head `1e516668…`. PR `#159` arrives at `mergeable: MERGEABLE, mergeStateStatus: CLEAN, reviewDecision: APPROVED, Test: SUCCESS` for the first time around 16:24Z. Auto-merge is **not** enabled on the PR.
5. **2026-05-20 14:29:45 → 16:18:20Z** — Code-review and fix-pr loop on PR `#162`: six reviews from `caretta-ai[bot]`, the last `APPROVED` against head `a79467c8…`. PR `#162` arrives at `mergeable: MERGEABLE, mergeStateStatus: CLEAN, reviewDecision: APPROVED, Test: SUCCESS` around 16:18Z. Base ref is still `agent/issue-155`. Auto-merge is **not** enabled. `closingIssuesReferences` is empty on PR `#162` (GitHub does not populate the closing-references edge for PRs whose base is not the default branch in this repo), even though the body contains `Closes #156`.
6. **2026-05-20 19:07:36Z (scheduled tick, run `26183993651`)** — First tick after both PRs reach merge-ready state. `decideExecution` routes to `work` with tracker `#157`. `runWorkDispatch` calls `caretta tracker-matrix 157 --json` and logs `Found 0 issues in tracker matrix.`. Loops `for (const issue of issues)` is skipped (no fresh work to dispatch — correct in isolation, but vacuous because the parser is wrong). `auto-merge --sync-branches --tracker 157` runs, logs `auto-merge (lineage): sequence (issue #): 153 → 156`, calls `gh pr update-branch` on `#159` (succeeds), tries to retarget `#162` to `main` (fails: `Giving up on PR #162 (#156): unable to align base to 'main'.`). `dispatchMissingCi` confirms both PRs already have green `Test`. `runCiGate` confirms both. `resolveTrackerScopedPrs(issues=[], requirePassingCi=true)` runs `agentPrNeedsReviewOrFix` per candidate; both PRs are already APPROVED on the head SHA, so the function returns `false` and the autopilot logs `Skipping PR #N: already reviewed for <SHA> or CI not actionable` for each. `prsForReview = []`, so the post-review block is skipped. `queuedPrs = prsAfterFix.filter(pr => issueStringsAfterFix.includes(match[1]))` filters against `issueStringsAfterFix = []`, returning `[]`. `needsAutomerge = false`. The autopilot logs `All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue.` — false on the facts (both PRs have `autoMergeRequest: null`), true on the logic (the queued set is empty). The tick completes with `conclusion: success`. **No state was changed; both PRs remain wedged.**
7. **2026-05-21 01:21:15Z (scheduled tick, `26199725970`)** — Identical no-op tick. `Found 0 issues in tracker matrix.` etc.
8. **2026-05-21 07:36:55Z (scheduled tick, `26212343929`)** — Identical no-op tick.
9. **2026-05-21 12:50:54Z (workflow_dispatch, `26227011007` — the run inspected for this post-mortem)** — Identical no-op tick. Job ran 1m31s. Key log lines (UTC, abridged):

   ```
   12:51:52  Starting work dispatch for #157
   12:51:54  Found 0 issues in tracker matrix.
   12:51:55  auto-merge (sync (update branches)): trunk base 'main'
   12:51:56  auto-merge (lineage): using tracker #157 for deterministic execution order
   12:51:56  auto-merge (lineage): sequence (issue #): 153 → 156
   12:51:57  Merging latest base into PR #159 (`gh pr update-branch`)…
   12:52:02  Retargeting PR #162 to merge into 'main'…
   12:52:05  GraphQL: Something went wrong while executing your query on 2026-05-21T12:52:04Z. Please include `2039:219570:2A40987:A235E7E:6A0EFFF3`…
   12:52:05  Giving up on PR #162 (#156): unable to align base to 'main'.
   12:52:05  auto-merge (sync (update branches)): pass complete.
   12:52:16  dispatchMissingCi: PR #162 already has a successful "Test" check.
   12:52:17  dispatchMissingCi: PR #159 already has a successful "Test" check.
   12:52:19  runCiGate: PR #162 (agent/issue-156) at SHA a79467c… latest "Test" check is completed (success).
   12:52:20  runCiGate: PR #159 (agent/issue-153) at SHA 1e51666… latest "Test" check is completed (success).
   12:52:23  Skipping PR #162: already reviewed for a79467c… or CI not actionable
   12:52:24  Skipping PR #159: already reviewed for 1e51666… or CI not actionable
   12:52:25  All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue.
   ```

10. **2026-05-21 (post-incident, "now")** — `gh pr view 159 …` reports `mergeable: MERGEABLE, mergeStateStatus: CLEAN, reviewDecision: APPROVED, Test: SUCCESS, autoMergeRequest: null`. `gh pr view 162 …` reports the same plus `baseRefName: agent/issue-155`. `git ls-remote --heads` reports `agent/issue-153`, `agent/issue-154`, `agent/issue-155`, `agent/issue-156` all still present (none of the post-merge branches were deleted; same gap as 2026-05-20). Tracker `#157` body shows `[x]` for `#154`, `#155`, `#156` (and `[ ]` for `#153`); the table-section "Status" column still shows `🔴 Not Started` for all four rows (a separate drift, unrelated to this incident's primary cause but consistent with the autopilot writing checklist updates without re-rendering the table).

## Root cause

### 1. The tracker parser leaks `(blocked by #X)` references into the `completed` set

`crates/cli/src/agent/tracker/mod.rs:125-152` in the parent `caretta` crate iterates every line in the tracker body. If the line contains `[x]` (or `✅`/`✔️`/`☑️`/`done`/`complete`), it extracts **all** `#N` references on the line via `extract_issue_refs` (line 138). For lines that don't contain `|`, every reference goes into `completed`:

```rust
if is_done {
    let refs = extract_issue_refs(line);
    if line.contains('|') {
        if let Some(&first) = refs.first() { set.insert(first); }
    } else {
        for num in refs {
            set.insert(num);   // <-- "blocked by #X" leaks here
        }
    }
}
```

Tracker `#157`'s checklist section has lines like:

```
- [x] #154 F4: Prometheus /metrics endpoint (blocked by #153)
- [x] #156 C5: Bearer token auth on POST endpoints (blocked by #155)
```

Neither line contains a `|`. So `extract_issue_refs` returns `[154, 153]` for the first and `[156, 155]` for the second, and `parse_completed` returns `{153, 154, 155, 156}` instead of `{154, 156}` (the actually-ticked items). The blocker references — which are documenting *dependency*, not completion — are being conflated with completion.

`parse_pending` (`tracker/mod.rs:154-225`) then iterates pending markers (`[ ]`, `🟡`, `🔴`) and excludes any number already in `completed` (line 171: `if completed.contains(&number) || !seen.insert(number) { continue; }`). The `- [ ] #153 …` line is the only `[ ]` line in the body, but #153 is in `completed`, so it's pruned. The four `🔴` rows in the dependency table likewise have their first-ref number in `completed`, so they are pruned too.

Result: `pending_issues_execution_order` returns `[]`. `tracker-matrix #157 --json` prints `[]`.

This was verified empirically by running the same parser logic against the live `gh issue view 157 --json body` payload:

```
completed: {153, 154, 155, 156}
pending: []
```

The fix is two lines: for non-table `[x]` lines, take only the *first* `#N` reference, matching the table-row heuristic on the next branch:

```diff
-            } else {
-                for num in refs {
-                    set.insert(num);
-                }
-            }
+            } else if let Some(&first) = refs.first() {
+                set.insert(first);
+            }
```

The first `#N` on a checklist row is the row's subject; trailing `#N` references on `[x]` rows are commentary (typically `(blocked by …)`, `(closes …)`, or `(see #…)`) and should not contribute to the completed set. This is the same assumption already encoded in the table-row branch, just not generalized.

### 2. The autopilot gates the automerge-queue on `issueStringsAfterFix.length > 0`, conflating "no fresh work to dispatch" with "no open PRs that need auto-merge"

`src/application/execute-autopilot.ts:325-353`:

```ts
const prsAfterFix = await this.gh.listOpenPullRequests();
const issueStringsAfterFix = issues.map(String);
const queuedPrs = prsAfterFix.filter((pr) => {
  const match = pr.headRefName.match(/^agent\/issue-([0-9]+)(?:-.*)?$/);
  return match && issueStringsAfterFix.includes(match[1]);
});

const needsAutomerge = queuedPrs.some((pr) => !pr.isAutoMergeEnabled);

if (needsAutomerge) {
  await this.runCaretta("auto-merge", ["--tracker", tracker, "--automerge-queue"]);
  await dispatchMissingCi(this.gh, this.config);
} else {
  core.info(
    "All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue.",
  );
}
```

`issues` is the result of `tracker-matrix #N --json` (line 280). When the parser regression in §1 makes that empty, `issueStringsAfterFix = []`, `[].includes(any)` is `false`, `queuedPrs = []`, and `[].some(...)` is `false`. The `else` branch runs and logs a message that is **logically equivalent** to "the queued set is empty" but **reads as** "every queued PR already has auto-merge enabled" — which is the opposite of the truth on the day this regression triggers (both PRs have `autoMergeRequest: null`).

Compare this to `resolveTrackerScopedPrs` (`execute-autopilot.ts:402-433`), which has the correct fallback:

```ts
const candidates = prs.filter((pr) => {
  if (pr.isDraft || pr.mergeStateStatus === "DIRTY") return false;
  const match = pr.headRefName.match(/^agent\/issue-([0-9]+)(?:-.*)?$/);
  if (issueStrings.length > 0) {
    return match && issueStrings.includes(match[1]);
  }
  return !!match;   // <-- when no tracker scope is provided, accept all agent PRs
});
```

When `issueStrings` is empty, `resolveTrackerScopedPrs` falls back to "all agent PRs", which is why the autopilot still examined `#159` and `#162` for review-or-fix and emitted the "Skipping … already reviewed" log lines (steps 6 and 9 of the timeline above). The `queuedPrs` filter for automerge-queue has no such fallback, so it diverges from the rest of the function under exactly the conditions where the rest of the function is generous.

This is a coupling bug: the automerge-queue invocation should be gated on the *existence of open agent PRs needing auto-merge*, not on the *count of tracker-matrix issues this tick*. Those two quantities happen to align in the common case but decouple precisely when tracker-matrix returns empty for any reason — whether because the parser is broken (this incident) or because the sprint is genuinely finished but some PRs are mid-merge.

### 3. Stacked PR #162's base branch survived the squash-merge and cannot be retargeted

PR `#161` (head `agent/issue-155`, base `main`) merged at 2026-05-20T14:41:19Z via squash (allowed merge methods on the ruleset: `["squash", "rebase"]`; commit `275956c2…` on `main` is the squash). The squash commit on `main` has a different SHA than `agent/issue-155`'s tip (`3d177001…`), and `git merge-base` between the two now produces a divergence: `gh api repos/.../compare/main...agent/issue-155 → {ahead: 2, behind: 1, status: "diverged"}`.

Caretta's `auto-merge --sync-branches` logic (per the run log, lines 12:51:55 → 12:52:05Z) walks the lineage `153 → 156`, treats `#159` as a default-branch PR (calls `gh pr update-branch`, succeeds), and treats `#162` as a stacked PR (the base is not `main`), so it tries to **retarget** the base from `agent/issue-155` to `main`. The retarget would only succeed if `agent/issue-156`'s diff against `main` produced only the `#156`-specific changes — but because `#155`'s work landed on `main` as a different SHA (the squash), the diff `agent/issue-156` vs `main` includes the `#155` work as a re-application. Retarget refuses and the autopilot logs `Giving up on PR #162 (#156): unable to align base to 'main'.`

(The accompanying transient `GraphQL: Something went wrong … 2026-05-21T12:52:04Z` in the run log is a side-show — it's a single GitHub-side hiccup on the `pulls.update` call, and the "giving up" log line follows ~30ms later either way. Even on a non-transient run, `Giving up` is the expected outcome until the base is repaired.)

There is no fallback. The autopilot does not (a) merge `main` into `agent/issue-156` first to absorb the squashed `#155` work and then retarget, (b) close `#162` and reopen with `agent/issue-156` rebased onto `main` directly, or (c) warn an operator that `#162` is in a state only manual intervention can repair.

This is the same branch-cleanup gap catalogued in `2026-05-20-issues-not-closed-on-main-merge-trigger-duplicate-prs.md` (§ "No post-merge branch-cleanup path"). The 2026-05-20 incident kept the gap latent because the affected PRs were all default-branch PRs; this incident exposes the second-order consequence on a *stacked* PR.

### How the three failures stack

```
caretta parser leaks (blocked by #X) into completed (§1)
    ↓
tracker-matrix #157 returns []
    ↓
runWorkDispatch dispatches no fresh work (correct)
    ↓
runWorkDispatch's automerge-queue invocation gates on issueStringsAfterFix.length > 0 (§2)
    ↓
auto-merge never enabled on #159 or #162
    ↓
#159 is otherwise merge-ready (default base, approved, green) → wedged on auto-merge alone
#162 is also blocked by base-misalignment (§3) → wedged on auto-merge AND base
    ↓
Every subsequent tick repeats the same no-op cycle
```

Any one of the three would have broken the chain. Fixing §1 alone would have made `tracker-matrix` return `[153]`, which would have made `queuedPrs` contain at least PR `#159`, which would have set `needsAutomerge = true` and enabled auto-merge on `#159` (which would have promptly merged). PR `#162` would still be wedged on §3, but at least one of the two would have unstuck. Fixing §2 alone would have made the gate "do we have any agent PR matching the pattern that doesn't have auto-merge enabled?", which would have enabled auto-merge on both PRs even with `issues = []`; `#159` would have merged, and `#162` would have made forward progress on the auto-merge side while remaining wedged on base. Fixing §3 alone would have moved `#162` to base `main` but would not have enabled auto-merge on either PR.

The cheapest fix and the one with the broadest reach is §1 (a two-line change in `caretta`), but it lives in the parent repo and is not directly fixable from this package.

## Test-coverage gap

### A. No caretta unit test asserts that `parse_completed` ignores trailing `#N` references on `[x]` lines

There are tests in `crates/cli/src/agent/tracker/` covering checklists and pending parsing (per the file's `mod tests` discoverable via grep, not enumerated here). None of them, to the best of this incident's grep evidence (no test file references a `(blocked by #` pattern inside an `[x]` checklist line), assert the specific case "a `[x]` row whose body contains `(blocked by #X)` must add only the row's first issue number to the completed set, not the blocker reference." That single regression test, with the failing assertion `assert_eq!(parse_completed("- [x] #154 (blocked by #153)\n"), HashSet::from([154]))`, would have caught this defect at PR-time.

### B. No autopilot-action integration test exercises "tracker-matrix returns empty *and* open agent PRs exist needing auto-merge"

`tests/run.test.ts` covers the routes and many edge cases, but nothing simulates the cross-tick steady state where (a) `tracker-matrix` returns an empty issue list and (b) the open-PR list contains agent PRs whose `autoMergeRequest` is unset. The autopilot would call `auto-merge --automerge-queue` in that scenario only if the test framework wired a non-empty tracker-matrix result, which the current fixtures do. A targeted test that fakes `caretta tracker-matrix` returning `"[]"` while the GitHub fake reports two agent PRs in merge-ready state would have failed against the current `issueStringsAfterFix` filter and forced the fix into design.

### C. No test asserts the run-log statement of the skip is truthful

The log line `All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue.` is emitted from the `else` branch of `needsAutomerge`. There is no assertion that, when this line is logged, the queued set is non-empty (so the statement is meaningful) and all members of the set have `isAutoMergeEnabled === true`. A regression test that runs the cycle with `queuedPrs = []` and asserts a *different* log message ("No tracker-scoped agent PRs found this tick; skipping automerge-queue check.") would have caught the misleading log at code-review time. The current code passes its tests because the log line is treated as cosmetic, but operationally it is the most important diagnostic signal the function emits.

### D. No contract test for stacked-PR base-misalignment

`packages/action-common/`'s fake GitHub client supports per-PR `baseRefName`, but there is no integration test that asserts: "given a stacked agent PR whose base branch has been squash-merged into `main` and the branch still exists, the autopilot detects the divergence and (a) refuses to silently retarget, (b) emits a `core.warning` naming the PR and the divergence, (c) does **not** treat the PR as merge-ready for any subsequent gate." The current code path "tries → fails → gives up" is observable only in the caretta binary's log output (which surfaces as a single `core.info` line `Giving up on PR #162 …`), not as a structured warning in the autopilot's own output, so a downstream test cannot inspect for the failure signal even if it wanted to.

## What went well

- **The wedge is loud in the right place if you look in the right place.** Both stuck PRs surface as OPEN on the repo's PR list with banner status that is internally consistent (APPROVED + green checks). An operator opening either PR sees the merge button is greyed out only because auto-merge is not enabled — there is no confused state, no DIRTY mergeStateStatus, no missing review. The "look at the GraphQL `autoMergeRequest` field" diagnosis is one `gh pr view --json autoMergeRequest` call away.
- **The autopilot log clearly states the GraphQL retarget failure** (`Giving up on PR #162 (#156): unable to align base to 'main'.`), which made root cause §3 obvious in 30 seconds. The corresponding "auto-merge not enabled" half is not obvious from the log (it's hidden inside the misleading "already enabled" message), but the retarget side is well-instrumented.
- **The empirical reproduction of the parser bug was trivial** — copy the parser logic into a 60-line `rustc`-compatible test program, feed it the live tracker body via `gh issue view 157 --json body --jq .body`, and observe `completed: {153, 154, 155, 156}; pending: []`. Total investigation time including writing this section: about 35 minutes from "look at the latest run" to "all three root causes identified and one verified by re-running the parser in isolation."
- **The "5 ticks since 19:07Z produced byte-identical no-op output" pattern is itself a strong signal** that the autopilot is in a steady-state loop rather than a transient. If the autopilot had a "no state changed in N consecutive ticks" alarm (it doesn't), this regression would have been caught hours earlier.

## What went poorly

- **The "all PRs already have auto-merge enabled" log is the textbook example of [a "silent failure log line"](https://en.wikipedia.org/wiki/False_friend) — it confidently asserts a state that happens to be false in the regression case.** The right shape for that log is conditional on the set's contents: if `queuedPrs.length === 0`, emit a different message ("no tracker-scoped PRs to check this tick"); if all members have `isAutoMergeEnabled`, emit the current message. The current code conflates the two and emits the second message in both cases, which is exactly the conflation that hides the regression.
- **The `caretta` parser's "blocked by" leak is a latent defect that has been present since the dependency-table convention was adopted in the example repo's tracker template.** It has gone unnoticed because most sprint cycles either (a) finish all items in the same tick the last `[x]` is ticked, so the empty-tracker-matrix state never persists, or (b) trigger a different code path (e.g., the autopilot's hold gate) that makes the eventual stuck-PR observable for some other reason. The two-PR-stuck-for-22-hours pattern is the first time the silent leak has been load-bearing.
- **PR `#162` is the second post-mortem in three days where a squash-merged agent branch was not deleted and caused downstream damage.** The 2026-05-20 incident's action item to "Add a `deleteBranch(ref)` method to `GitHubClient` and a post-close-on-merge call site" remains open. This incident is the second-order consequence — a *stacked* PR whose stacked-base got squashed has nowhere to go because the branch is alive but historically dead. Branch cleanup is now blocking at least two distinct failure modes.
- **The autopilot's "tracker-matrix returns 0" path has no health check.** A scheduled cron that fires every ~6 hours and consistently reports `Found 0 issues in tracker matrix.` in a sprint that contains two open agent PRs in the tracker scope is a strong inconsistency signal — but nothing in the autopilot compares the tracker-matrix output against the live open-agent-PR set and warns when they disagree. The same shape of inconsistency check appears in the 2026-05-20-issues-not-closed post-mortem ("tracker drift sweep" — still open). A single tick-end sweep that emits `core.warning` when `(open agent PRs scoped to tracker N).length > (tracker-matrix N).length` would have surfaced this incident on the very first stuck tick.
- **The retarget failure for PR `#162` is logged as `core.info` ("Giving up on PR #162 (#156): unable to align base to 'main'."), not `core.warning`.** A merge-blocking outcome should be warning-level so it shows up in the GitHub Actions annotation panel, where operators actually look. The current `info`-level emission gets lost in the regular log stream.

## Action Items

| Action | Owner | Due | Status |
|--------|-------|-----|--------|
| In the parent `caretta` repo, `crates/cli/src/agent/tracker/mod.rs:138-148`, take only the first `#N` reference from non-table `[x]` lines (mirror the table-row heuristic). Add a regression test in `crates/cli/src/agent/tracker/tests.rs` (or wherever the tracker tests live) using the live tracker `#157` body shape: `- [x] #154 (blocked by #153)` → `parse_completed` returns `{154}`, *not* `{153, 154}`. | TODO | TODO | Open. Out of this package's scope; needs a PR in `geoffsee/caretta`. |
| In `src/application/execute-autopilot.ts:325-353`, decouple the automerge-queue invocation from `issueStringsAfterFix`. Either (a) reuse `resolveTrackerScopedPrs(issues, false)` to get the same fallback semantics ("all agent PRs when issueStrings is empty"), or (b) inline the same `issueStrings.length === 0 ? "all" : "filter"` branch into the `queuedPrs` filter. The post-fix invariant is: "if any open agent PR matching the configured pattern has `isAutoMergeEnabled === false`, enable auto-merge on it, regardless of whether tracker-matrix found new work this tick." | Geoff | 2026-05-21 | **Shipped in `d5e1b40`** — `queuedPrs` now falls back to "all open agent PRs" when `issueStringsAfterFix.length === 0` (mirrors `resolveTrackerScopedPrs`). Plus a new direct `enablePullRequestAutoMerge` call per merge-ready PR (skips stacked PRs whose base ≠ default branch). Verified firing in run `26231855013` — both PRs entered the new code path; #162 correctly skipped on the stacked-PR safety check; **#159 failed with `Pull request Pull request is in clean status`** because GitHub's mutation requires a pending gate. Follow-up action below. |
| Replace the misleading log line `All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue.` with a state-aware emit: `core.info("No tracker-scoped agent PRs found this tick; skipping automerge-queue check.")` when `queuedPrs.length === 0`, and the current message when `queuedPrs.length > 0 && needsAutomerge === false`. The two cases are operationally distinct — one is "the queue is empty" and the other is "the queue is full of already-enabled PRs" — and conflating them in the log was the diagnostic time-sink in this incident. | TODO | TODO | Open. |
| Add an integration test in `tests/run.test.ts` for the steady-state regression: `mockExec` returns `"[]"` from `caretta tracker-matrix`, `gh.listOpenPullRequests()` returns two agent PRs in merge-ready state with `isAutoMergeEnabled: false`, and the assertion is that `runWorkDispatch` invokes `caretta auto-merge --tracker N --automerge-queue` (i.e. calls `runCaretta("auto-merge", ["--tracker", "N", "--automerge-queue"])`) and that `mockExec`'s recorded arguments contain the `--automerge-queue` flag. The current code fails this test. | Geoff | 2026-05-21 | **Shipped in `d5e1b40`** — `tests/execute.test.ts` gained +99 lines covering the empty-tracker-matrix-plus-open-PRs scenario and the stacked-PR safety skip. `tests/fakes.ts` gained a `baseRefName` field on the fake PR shape and an `enableAutoMerge` recorder on the fake GitHub client. |
| Reconcile the live state on the example repo immediately by hand: enable auto-merge on `#159` (which will merge it inside a minute given the green ruleset). For `#162`, the manual path is to (a) on a local clone, `git fetch && git checkout agent/issue-156 && git rebase main && git push --force-with-lease`, (b) `gh pr edit 162 --base main`, (c) re-request a bot review (the head SHA will change post-rebase, invalidating the existing APPROVED review under `require_last_push_approval`), (d) once approved again, enable auto-merge. After both PRs merge, delete `agent/issue-153`, `agent/issue-154`, `agent/issue-155`, `agent/issue-156` via `gh api -X DELETE repos/geoffsee/autopilot-example-project/git/refs/heads/agent/issue-N`. The tracker `#157` body will need its checklist `- [ ] #153` ticked manually (the autopilot's `updateTrackerChecklist` runs inside `closeIssuesForMergedPrs`, which will fire when `#159` merges with `Closes #153`, so this may auto-correct). | TODO | TODO | Open. |
| Add a tracker-vs-PR consistency check at the end of `runWorkDispatch` (or in `decideExecution`): if `tracker-matrix` returns `[]` but the open-PR list contains any `agent/issue-N` PRs where `N` is referenced in the tracker body (regardless of checkbox state), emit `core.warning("Tracker-PR drift: tracker #T returns 0 pending issues but PR #N (agent/issue-N) is open in tracker scope.")`. This is the consistency invariant that, if it had existed, would have caught this regression on the first wedged tick. Same shape as the "tracker drift sweep" action item still open from 2026-05-20-issues-not-closed-on-main-merge-trigger-duplicate-prs.md. | TODO | TODO | Open. |
| Upgrade the retarget-failure log from `core.info` ("Giving up on PR #N (#M): unable to align base to 'X'.") to `core.warning`, so the GitHub Actions annotation panel surfaces the stuck stacked PR. The text should also name the suspected base branch and suggest the manual rebase recipe ("base branch <X> has diverged from main; consider rebasing #M onto main and re-pointing the PR base"). Lives in `caretta` (parent crate) since that's where the log is emitted. | TODO | TODO | Open. |
| Re-prioritize the still-open action item from 2026-05-20-issues-not-closed-on-main-merge-trigger-duplicate-prs.md: **"Add a `deleteBranch(ref)` method to `GitHubClient` and a post-close-on-merge call site that deletes the agent branch for each successfully closed issue."** This incident is the second post-mortem in three days where the same gap is load-bearing on a different failure mode (duplicate PRs then; stacked-PR base-misalignment now). The action item is no longer "nice to have"; it is the structural fix for an entire class of post-merge wedge. Suggest pulling it forward to the next sprint and adding a complementary contract test: "post-close-on-merge, every successfully-closed issue's `agent/issue-N` branch is deleted, unless it's the head ref of another OPEN PR." | TODO | TODO | Open and re-prioritized by this incident. |
| Add a "no state changed in N consecutive ticks" sanity check. Cheapest implementation: at the end of each `executeAutopilot` invocation, write a short hash of `(merged PR numbers since last tick, opened PR numbers since last tick, dispatched workflow runs since last tick)` to a file in `${RUNNER_TEMP}` or, better, to a tracker issue's body as a hidden marker. On the next tick, compute the same hash; if it's identical to the previous N (3? 5?) ticks, emit `core.warning("Autopilot has produced no observable state change in N consecutive ticks; this is likely a stuck PR or a tracker-PR drift — see post-mortem 2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md.")`. This is the *meta-invariant* that catches steady-state wedges across all incident types — it would have caught this one, would have caught the duplicate-PR loop on 2026-05-20, and would catch future incidents of unknown shape. | TODO | TODO | Open. Lower priority than the targeted fixes above but mentioned for completeness. |

## Lessons (provisional)

1. **An empty result is not an inert result.** When `tracker-matrix` returns `[]`, every downstream filter that conjuncts against it collapses to `[]` and every downstream branch that gates on `length > 0` falls through to a "skip" path. The autopilot has three such filters/gates in `runWorkDispatch` alone (the dispatch loop, the `prsForReview` candidate filter with its `requirePassingCi=true` fallback, and the `queuedPrs` filter for automerge-queue). Two of the three correctly handle the empty case as "consider all"; the third doesn't. Wherever the codebase has a downstream filter that depends on an upstream "set of issues this tick," audit it for empty-set behavior and decide explicitly: "is empty here a *signal* (nothing to do) or a *default* (apply to all)?" Encoding that decision once at the filter site is a one-line change; finding the bug after it triggers a 22-hour wedge is, well, this post-mortem.

2. **Log lines that describe a state should be testable for the state they describe.** `All tracker-scoped PRs already have auto-merge enabled.` is *false* in this incident — the PRs have `autoMergeRequest: null`. If the log line had been written as a function of an explicit state predicate (`if queuedPrs.length > 0 && queuedPrs.every(pr => pr.isAutoMergeEnabled)`), it would be true exactly when it claims to be. Writing the log as the `else` branch of a different predicate (`!needsAutomerge`, which is `true` when *either* the set is empty *or* every member is enabled) is what causes the false claim. The general rule: a log line that asserts X should be guarded by the same predicate that proves X, not by a strict superset.

3. **Stacked PRs are an unusual but real shape that the autopilot's merge path does not handle gracefully when the stack's roots merge with rewriting (squash).** The example repo's ruleset allows squash and rebase; both rewrite history. Every squash-merge of a stacked-base leaves any stacked-on PRs in the same misalignment state as PR `#162` is in today. The autopilot's current `Retargeting → Giving up` path is the right *immediate* behavior (don't fabricate a retarget), but the long-term behavior (a stuck PR no automation can repair) is wrong. The repair recipe — `git rebase main && git push --force-with-lease && gh pr edit --base main && re-request review` — is well-understood and could be automated as a `caretta` subcommand or a one-shot operator script. Until then, every stacked PR whose base squash-merges into `main` is a manual cleanup.

4. **The post-mortem corpus is forming a pattern.** This is the fourth incident in two weeks (2026-05-18, 2026-05-19, 2026-05-20 ×2, 2026-05-21) where the failure shape is "the autopilot produces one half of a state transition and assumes the other half happens elsewhere; the other half doesn't happen; there is no reconciliation pass to detect that; the autopilot keeps running and produces no forward motion until an operator intervenes." Specific instances:

    - 2026-05-18: dirty PR skipped during active CI hold (forward motion blocked by hold-gate; no detector).
    - 2026-05-19: same shape on a different PR.
    - 2026-05-20a: bot-merged PRs don't auto-close issues (forward motion blocked at issue layer; no detector — duplicate PRs were the unintended detector).
    - 2026-05-20b: PR #141's failed checks masked as pending (forward motion blocked by stale commit status; no detector).
    - 2026-05-21 (this incident): tracker-matrix returns [] due to parser leak, automerge-queue gates on the same empty set, PRs sit forever; no detector.

    The pattern is identical and the right fix is structural: a first-class "did the previous tick's stated work actually happen, and is the open-PR set consistent with the tracker state?" reconciliation pass at the start (or end) of every tick. Each individual incident's targeted fix is cheap and worth doing, but the *meta-fix* is the consistency sweep — and every additional incident in this shape is more evidence that it pays for itself.

5. **A wedge in production that produces no log noise is more dangerous than a wedge that produces obvious errors.** This incident's run logs all show `conclusion: success`. The GitHub Actions UI shows five green checkmarks in a row. Nothing about the surface presentation suggests anything is wrong; the PRs are open and have green checks; the autopilot runs every 6 hours without errors. Only a human (or a sufficiently-attentive operator) noticing "those PRs have been open longer than usual" would surface the regression. **The autopilot has no notion of expected SLOs** ("PRs in tracker scope should reach merged state within N ticks of becoming merge-ready"), and absent an SLO, the wedge is invisible to any automated alarm. Defining and emitting that SLO violation as a `core.warning` would convert this class of regression from "operator notices after hours/days" to "operator notices at the next tick." The cost is ~10 lines of code plus a tracker-issue or sticky note where the SLO state lives between ticks.

## Fixes applied (commit `d5e1b40`, 2026-05-21 ~14:18Z)

Source changes (autopilot-action only — the upstream `caretta` parser regression in §1 and the retarget-log-level upgrade in `caretta` are still untouched):

- **`src/application/execute-autopilot.ts:325-380`** — `queuedPrs` filter now falls back to "all open agent PRs matching `^agent/issue-([0-9]+)`" when `issueStringsAfterFix.length === 0`, mirroring the same fallback shape already present in `resolveTrackerScopedPrs`. With the fallback, the §2 gate no longer collapses to a no-op when `tracker-matrix` returns `[]` (which it still does on every tick — root cause §1 is unfixed).
- **`src/application/execute-autopilot.ts:338-373` (new "14a" block)** — before the existing caretta `--automerge-queue` call, the autopilot now iterates `queuedPrs` and calls `this.gh.enableAutoMerge(pr.number)` on each PR that lacks auto-merge. Stacked PRs (base ≠ default branch) are explicitly skipped with a `core.info` log so the §3 silent-retarget hazard is converted into an observable skip rather than an attempted GraphQL retarget. Errors from the mutation are caught and logged via `core.warning` (this is the catch-site that emitted `Failed to enable auto-merge on PR #159: Pull request Pull request is in clean status` in the verification run — see below).
- **`packages/action-common/src/github-client.ts:53-59,141,388-407`** — new `enableAutoMerge(prNumber)` method on `GitHubClient` (fetches the PR's GraphQL node id via REST, then runs the `enablePullRequestAutoMerge` mutation with `mergeMethod: SQUASH`). Plus `baseRefName` is now populated on the PR shape returned by `listOpenPullRequests` so the stacked-PR safety check has the data it needs.
- **`packages/action-common/src/types.ts`** — `baseRefName: string` added to the `PullRequest` type (and to the fake shape in `tests/fakes.ts`).
- **`tests/execute.test.ts` (+99 lines)** — new test cases for: (a) `runWorkDispatch` calling `enableAutoMerge` on merge-ready default-branch agent PRs when `tracker-matrix` returns `[]`; (b) the stacked-PR safety skip (base ≠ default branch ⇒ `enableAutoMerge` NOT called); (c) `enableAutoMerge` errors are caught and logged as warnings, not thrown.
- **`dist/index.js` and the per-action `packages/*-action/dist/index.js` bundles** — rebuilt to ship the source change to GitHub Actions runners (the `@main` SHA the example repo pulls is `d5e1b40` for the verification run).

What this fix is designed to handle:

| Scenario | Before `d5e1b40` | After `d5e1b40` |
|----------|------------------|-----------------|
| `tracker-matrix` returns `N` issues; some matching agent PRs lack auto-merge | Calls caretta `--automerge-queue` (legacy path). | Same — `queuedPrs` filter matches `N`; both the new direct-enable loop and the legacy caretta call fire. |
| `tracker-matrix` returns `[]`; no open agent PRs in tracker scope | Skipped (correct). | Skipped (correct — `queuedPrs = []`; `needsAutomerge = false`). |
| `tracker-matrix` returns `[]`; open agent PRs exist needing auto-merge (this incident's wedge) | **Skipped with the misleading "All tracker-scoped PRs already have auto-merge enabled" log line** (wrong). | `queuedPrs` falls back to all agent PRs; direct-enable loop fires per-PR (subject to the new defect below). |
| Stacked PR whose base has been squash-merged into `main` (this incident's PR #162) | Caretta retargets and emits `Giving up on PR …` at `core.info`; no autopilot-side handling. | Direct-enable loop **skips with `core.info("Skipping auto-merge enable for PR #N: base '…' is not the default branch '…' (stacked PR needs rebase+retarget first).")`** — observable, named, safe (does not orphan the stacked work onto a dead base). |
| Merge-ready PR with `mergeStateStatus: CLEAN` and zero pending conditions | n/a (path didn't exist). | **NEW DEFECT** — GitHub's `enablePullRequestAutoMerge` mutation rejects with `Pull request Pull request is in clean status`; the warning is logged but the PR is left untouched. |

## State of run `26231855013` (job `77194174209`, 2026-05-21 14:19:43Z, workflow_dispatch) — partial unstick, both PRs remain wedged

URL: https://github.com/geoffsee/autopilot-example-project/actions/runs/26231855013/job/77194174209
Action SHA: `d5e1b40eec427d4937ce48ec9d8928100b7cf28d` (the fix commit; confirmed via `Download action repository 'geoffsee/caretta-autopilot-action@main' (SHA:d5e1b40…)` in setup log).
Caretta version: `0.11.14` (unchanged from previous runs — §1 parser bug still present upstream).
Job conclusion: **`failure`** (first non-success conclusion in the wedge sequence; cause is a transient GitHub HTML 5xx after `dispatchMissingCi`, not the fix path itself).
Runtime: 1m22s.

### Observed log sequence (UTC, abridged; full log in run artifacts)

```
14:20:32  Starting work dispatch for #157
14:20:32  Found 0 issues in tracker matrix.                                                  ← §1 parser bug, still unfixed in caretta v0.11.14
14:20:32  auto-merge (sync (update branches)): trunk base 'main'
14:20:34  auto-merge (lineage): sequence (issue #): 153 → 156                                ← caretta still computes lineage from tracker text
14:20:36  Merging latest base into PR #159 (`gh pr update-branch`)…
14:20:40  Retargeting PR #162 to merge into 'main'…
14:20:42  GraphQL: Something went wrong while executing your query on 2026-05-21T14:20:42Z…  ← transient (same retarget hiccup as 12:52Z, not load-bearing)
14:20:42  Giving up on PR #162 (#156): unable to align base to 'main'.                       ← §3 base-misalignment still present (caretta path)
14:20:42  auto-merge (sync (update branches)): pass complete.
14:20:48  dispatchMissingCi: PR #162 already has a successful "Test" check.
14:20:49  dispatchMissingCi: PR #159 already has a successful "Test" check.
14:20:52  runCiGate: PR #162 … completed (success).
14:20:53  runCiGate: PR #159 … completed (success).
14:20:54  All CI runs completed.
14:20:58  Skipping PR #159: already reviewed for 1e51666… or CI not actionable
14:21:00  Skipping auto-merge enable for PR #162: base 'agent/issue-155' is not the         ← NEW §3 safety check firing as designed
          default branch 'main' (stacked PR needs rebase+retarget first).
14:21:01  ##[warning]Failed to enable auto-merge on PR #159: Request failed due to          ← NEW §2 direct-enable firing,
          following response errors: - Pull request Pull request is in clean status          but failing on the very PR it's
                                                                                              meant to unstick
14:21:01  Running: caretta auto-merge --tracker 157 --automerge-queue
14:21:03  auto-merge (lineage): sequence (issue #):                                          ← caretta lineage empty (§1)
14:21:03  auto-merge (lineage): nothing scheduled after deterministic ordering
          filtered to open PR rows.
14:21:06  dispatchMissingCi: found 2 total open PRs
14:21:13  ##[error]<!DOCTYPE html> … <title>Unicorn! &middot; GitHub</title> …               ← transient GitHub 5xx; kills the job
```

### What the run proves

- **§2 (gate decoupling, `queuedPrs` fallback) works.** Both PR #159 and PR #162 entered the new direct-enable loop despite `tracker-matrix` returning `[]`. Before the fix, this set would have been empty and the loop never would have run.
- **§3 stacked-PR safety works as designed.** PR #162's base is `agent/issue-155` (not the default branch), so the autopilot logged `Skipping auto-merge enable for PR #162: base 'agent/issue-155' is not the default branch 'main' (stacked PR needs rebase+retarget first).` and moved on without calling `enableAutoMerge`. No silent retarget, no orphaning of #156 onto a dead base. The skip is now an observable structured log line, not an `info`-buried "giving up" from caretta.
- **§1 (caretta parser) is still broken upstream.** `Found 0 issues in tracker matrix.` and `auto-merge (lineage): nothing scheduled after deterministic ordering filtered to open PR rows.` both fire — the parent crate's `parse_completed` still leaks `(blocked by #X)` references. Out of this package's scope; needs a PR in `geoffsee/caretta`.
- **NEW DEFECT discovered: `enableAutoMerge` is a no-op against PRs that are already merge-ready.** PR #159 is `mergeable: MERGEABLE, mergeStateStatus: CLEAN, reviewDecision: APPROVED, Test: SUCCESS, autoMergeRequest: null`. There are no pending gates for GitHub to "wait" on, so the `enablePullRequestAutoMerge` mutation rejects with `Pull request Pull request is in clean status`. The autopilot catches the error as a `core.warning` and continues — but the PR stays open. The very PRs the §2 fix was written to unstick are exactly the PRs the GitHub API refuses to enable auto-merge on. The correct fallback in this state is `mergePullRequest` (direct squash), not `enablePullRequestAutoMerge`.
- **Transient GitHub 5xx terminated the run.** After `dispatchMissingCi` enumerated the two PRs (~14:21:08Z), the action exited with `##[error]<!DOCTYPE html>… Unicorn!…` — a GitHub-side 5xx page returned as the body of an API call. This is the first `conclusion: failure` in the wedge sequence (all prior ticks reported `success`); the error is not caused by the fix path and is unlikely to recur on every tick. **The failure status is, however, finally a signal an operator can alert on** — five preceding ticks had been reporting `success` while doing nothing useful, so any "alert on first failure" sees this run.

### Current live state (verified via `gh pr view` post-run, 2026-05-21 ~14:25Z)

```json
PR #159: {"number":159, "state":"OPEN", "baseRefName":"main",
          "headRefName":"agent/issue-153", "mergeable":"MERGEABLE",
          "mergeStateStatus":"CLEAN", "reviewDecision":"APPROVED",
          "autoMergeRequest":null, "isDraft":false}

PR #162: {"number":162, "state":"OPEN", "baseRefName":"agent/issue-155",
          "headRefName":"agent/issue-156", "mergeable":"MERGEABLE",
          "mergeStateStatus":"CLEAN", "reviewDecision":"APPROVED",
          "autoMergeRequest":null, "isDraft":false}
```

Both PRs unchanged from the post-mortem's original "now" snapshot. The wedge persists; the autopilot has shipped *observability* but not *forward motion*. PR #159 can be unstuck by a single `gh pr merge 159 --squash` invocation against the example repo (no rebase, no review, no CI wait needed — everything is green); PR #162 still needs the manual rebase-and-retarget recipe documented in the original Action Items.

## New action item arising from this verification

| Action | Owner | Due | Status |
|--------|-------|-----|--------|
| In `src/application/execute-autopilot.ts:14a` (the new direct-enable loop), detect the `Pull request is in clean status` error class from `enablePullRequestAutoMerge` and fall back to `mergePullRequest` (squash) for that PR. Equivalent precondition without the error round-trip: when `pr.mergeStateStatus === "CLEAN"` and `pr.reviewDecision === "APPROVED"` and the required-checks set is satisfied, prefer `mergePullRequest` first; otherwise prefer `enablePullRequestAutoMerge`. Add a new `mergePullRequest(prNumber, method)` method to `GitHubClient` that wraps the GraphQL mutation, and extend the tests in `tests/execute.test.ts` so the merge-ready-PR scenario asserts `mergePullRequest` is called (not just `enableAutoMerge`). This is the fix that converts the §2 work in `d5e1b40` from "observable no-op on already-ready PRs" to "actually merges". | TODO | TODO | Open. **Highest-priority follow-up — the wedge will not clear without this.** |

## Lessons (revised, 2026-05-21 post-verification)

The original five lessons stand. Adding one:

6. **GitHub's `enablePullRequestAutoMerge` is the wrong primitive for "the PR is ready *right now*".** The mutation is, by design, "queue this PR to merge once its outstanding conditions are satisfied" — and it errors out when there are no outstanding conditions to satisfy. The correct primitive when `mergeStateStatus: CLEAN` and `reviewDecision: APPROVED` is `mergePullRequest`. Any automation that thinks of "enable auto-merge" as a generic "make this PR eventually merge" needs the two-call pattern: prefer `mergePullRequest` when the PR is fully ready; fall back to `enablePullRequestAutoMerge` when it isn't. Conflating the two is the same shape of empty-set-is-not-inert bug as the original §2 — `enablePullRequestAutoMerge` treats "the conditions-to-wait-on set is empty" as a hard error, not as "merge it now".

---
Note: The issues in here were almost all caused by missing assets that were expected to be temporarily materialized by caretta, but were missing in v0.11.12-0.11.13. Changes were made that were compensory to the misalignment.
