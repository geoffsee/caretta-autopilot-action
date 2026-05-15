# Post-mortem: Autopilot stalls on "Waiting for CI to complete..." when a PR has an undetected merge conflict

**Date:** 2026-05-15
**Status:** Resolved (workaround); follow-ups open

## Summary

An autopilot run hung indefinitely on the log line `Waiting for CI to complete...`. The cause was an open agent PR with a merge conflict against its base branch. The conflict prevented CI from producing a `Test` check on the PR's head SHA, and the autopilot's CI gate has no branch in its conditional for "branch is unmergeable" — it only treats a check as done when its status is neither `in_progress` nor `queued`. A missing check is indistinguishable from a queued check, so the gate kept polling.

## Impact

- One autopilot run was stuck for ~20+ minutes and had to be unblocked manually.
- Other agent PRs in the run were also waiting on the same gate, delaying their progression.

## Detection

Surfaced when the operator noticed the workflow had not advanced past step 3 (`Run geoffsee/caretta-autopilot-action@main`) for an extended period and asked us to inspect the gating logic.

## Root cause

The CI gate in `src/execute.ts` (`runCiGate`) considers a PR "done" only when a check run named `Test` exists on the head SHA with a terminal status. It does not inspect `pull_request.mergeable`. A PR in `CONFLICTING` state never produces that check, so the gate spins until its 20-minute timeout — and if the gate is entered late in the run, the operator sees the symptom as an indefinite hang.

In this specific case, the conflicting PR's base branch was another agent branch (not `main`), which made the conflict invisible to a casual `git merge origin/main` check.

## Resolution (this incident)

1. Identified the conflicting PR via `gh pr list --json mergeable`.
2. Checked out the branch and merged its actual base locally to surface the conflict.
3. Resolved the conflict by keeping the head branch's version (it already integrated the base's changes correctly).
4. Ran `bun test` locally — all green.
5. Pushed the merge commit to the PR branch.
6. Manually dispatched the `CI` workflow against the updated head via `gh workflow run`.
7. Verified the resulting run completed `success` and the `Test` check appeared on the new SHA.

## Related context

New repository rulesets are now in place for all branches and the default branch, requiring pull requests to merge with a passing `Test` check. This means a PR that never produces a `Test` check cannot merge at all — making the autopilot's silent stall mode more costly, since work blocked behind such a PR cannot trivially be force-merged.

## Follow-ups

- **Conflict detection in the CI gate.** Have the gate query `pull_request.mergeable` for each scoped PR and skip-or-fail-fast on `CONFLICTING`, instead of polling for a check that will never appear. Log the PR number explicitly so operators don't have to dig.
- **Make the wait message diagnostic.** Include which PRs are still pending and why (e.g., `missing Test check`, `in_progress`, `unmergeable`) on each poll, so a stall is self-explaining from the log alone.
- **Pre-commit hook in this repo.** Adding a pre-commit hook that runs `bun test` (and ideally `tsc --noEmit`) would catch failures before they reach a CI runner. Benefits:
    - Faster feedback loop — failures surface in seconds locally instead of minutes after pushing.
    - Saves CI minutes that would otherwise be burned on trivially broken commits.
    - Reduces the rate of red `Test` checks landing on PRs, which under the new rulesets directly translates to fewer merge blockers.
    - Catches the easy class of issues (syntax, type errors, obviously failing tests) before they cascade into autopilot-level stalls like this one.

## Mitigation options

These are ordered roughly from cheapest/fastest to most invasive. They are complementary, not mutually exclusive.

### 1. Treat `CONFLICTING` as a terminal state in `runCiGate`

The smallest viable fix. Before polling check runs for a scoped PR, fetch `pull_request.mergeable` and, if it is `false` (or `mergeable_state` is `dirty`), short-circuit the gate for that PR — log the conflict, mark it as needing human attention, and move on instead of waiting for a `Test` check that will never be produced.

Trade-off: GitHub computes `mergeable` lazily and can return `null` ("computing") for a window after a push. The implementation needs to tolerate `null` (poll once or twice, then assume the previous known state) rather than treating `null` as "no conflict."

### 2. Make the wait loop self-describing

Change the `Waiting for CI to complete...` log into a per-PR status table emitted on each poll, e.g.:

```
Waiting for CI:
  #15  agent/issue-6   Test: success
  #19  agent/issue-10  Test: in_progress
  #21  agent/issue-12  Test: missing (mergeable=false)
```

This turns a silent stall into a self-diagnosing one and removes the need for an operator to grep source code mid-incident to understand the gate. Cheap, high-leverage.

### 3. Bound the gate more aggressively and surface the timeout

Today the gate times out at 20 minutes and only emits `core.warning`. Consider:
- Reducing the timeout (e.g., 10 minutes) since a healthy `Test` run on this codebase completes well under that.
- On timeout, write a job summary listing the PRs that didn't complete and why, so it appears in the GitHub Actions UI without having to expand the log.
- Optionally fail the autopilot step on timeout rather than continuing silently, so the workflow's check turns red instead of green-with-a-warning.

### 4. Re-dispatch CI on the head SHA when no `Test` check exists

If the gate sees a scoped PR with `mergeable=true` and no `Test` check for the head SHA after the first poll, dispatch the `CI` workflow with `ref` set to the PR's head branch. This recovers from the case where the push happened but the `push`/`pull_request` triggers didn't fire (rare, but the operator already had to do this by hand twice today). Bound the number of re-dispatch attempts per SHA to avoid loops.

### 5. Auto-rebase or auto-merge of base into head for conflicted agent PRs

For agent PRs that conflict only with another agent branch (or with `main`), attempt a server-side merge of the base into the head, push the merge commit, and re-enter the gate. If the merge is non-trivial (real conflicts, not just stale base), fall back to flagging for human attention. This addresses the root cause directly but adds complexity and a new failure mode (bad auto-resolutions); gate it behind a config flag.

### 6. Pre-commit hook in consumer repos

Already called out in follow-ups; restating here because it is the only mitigation that prevents bad commits from ever reaching CI in the first place. A minimal hook running `bun test` and `tsc --noEmit` would have caught every CI failure we have seen so far. Pair with a `bun run check` script so the same command runs locally, in the hook, and in CI — guaranteeing parity.

### 7. Branch-protection-aware autopilot

Now that rulesets require a passing `Test` check to merge, the autopilot can short-circuit any PR whose head SHA has a failed `Test` check: don't wait for additional state, don't attempt downstream work, just report and stop. This makes the autopilot's contract match the repository's contract and avoids spending cycles on PRs that cannot merge regardless of what the autopilot does next.

### Preferred direction: in-loop detection and auto-resolution

The strongest version of this — and the operator's preference — is to fold detection and remediation into the same poll loop that already emits `Waiting for CI to complete...`, rather than splitting them across separate options. Concretely, on each iteration the loop would:

1. Query `pull_request.mergeable` (and related signals) for each scoped PR alongside the existing check-run query.
2. For any PR that is mergeable, continue waiting as today.
3. For any PR in `CONFLICTING`, attempt an automatic resolution — at minimum a server-side merge of the base into the head when the conflict is purely from a stale base; optionally a narrowly-scoped auto-resolution strategy for known-safe conflict shapes (e.g., import-block conflicts, lockfile regenerations).
4. If the auto-resolution succeeds, push the resulting commit, re-dispatch `CI` if needed, and resume the `Waiting for CI to complete...` loop against the new head SHA — without exiting the gate or paging an operator.
5. If the auto-resolution fails or is out of scope (real semantic conflict), flag the PR with a clear log line and either skip it or fail the gate fast, depending on configuration.

The appeal of putting this in the existing loop rather than alongside it:

- **Self-healing as the default.** The common case — a base advanced under an agent branch — fixes itself between polls, and the operator never has to learn the symptom exists.
- **Single source of truth for "is this PR done?"** The gate's exit condition becomes "every scoped PR is either green, terminally failed, or unrecoverably conflicted," which is exactly the question the gate is trying to answer.
- **Bounded by the same timeout.** No new control flow; the existing 20-minute budget covers both waiting and remediation. If auto-resolution can't converge in that window, the gate times out and surfaces the situation — same as today, but with a richer message.
- **Composes naturally with (2).** Each poll's status table now also reports remediation attempts (`merged base into head, re-dispatched CI`), making the loop's behavior fully legible from the log.

Risks to design around: GitHub's `mergeable` field can return `null` while it recomputes; auto-merge commits authored by the action need a stable identity and signing story; and any auto-resolution strategy beyond "merge base into head" should ship behind a feature flag with a per-repo allow-list, so an aggressive resolver doesn't silently produce wrong code on a repo that hasn't opted in.

#### Encapsulation

This logic is non-trivial — it spans GitHub API polling, mergeability state interpretation (including the `null`-while-recomputing case), git operations against a working tree, push and re-dispatch side effects, and a small policy layer for which resolution strategies are enabled. It does not belong inlined inside `runCiGate`.

It should live behind a dedicated abstraction — e.g., a `ConflictResolver` (or similarly named) class/module — with a narrow interface the gate calls into. A first-cut shape:

- `inspect(pr) -> { state: "clean" | "resolvable" | "unresolvable" | "unknown", reason }` — pure read; never mutates the repo.
- `attemptResolution(pr) -> { outcome: "resolved" | "skipped" | "failed", newHeadSha?, log }` — performs the side-effectful resolution and reports what it did.
- Strategy registration so resolution tactics (merge-base-into-head, lockfile regeneration, import-block merges, …) can be added, ordered, and feature-flagged independently of the gate.

The benefits of encapsulating it this way:

- **Testability.** Each strategy can be unit-tested against fixture conflicts without standing up the autopilot loop.
- **Bounded blast radius.** The gate's concern shrinks back to "poll for done-ness"; it doesn't grow a git client and a policy engine inline.
- **Reusability.** The same resolver can be invoked from other autopilot phases (or from a manual `gh` subcommand for operators) without duplicating logic.
- **Observability surface.** Strategies log through a single channel, so the per-poll status table from (2) gets consistent, structured remediation messages instead of ad-hoc strings.
- **Safer iteration.** New strategies land behind their own flags and can be rolled out per-repo without touching the gate.

#### Test approach (drives the implementation)

The pseudocode below sketches the test surface that should exist *before* the resolver is written. Each block names a behavior, the inputs it sets up, and the assertion it makes; together they constrain the implementation into the shape described above without prescribing internals.

```ts
// ─── Fakes / fixtures ─────────────────────────────────────────────────────
// A `FakeGitHub` that returns scripted values for:
//   - pulls.get(number).mergeable           (true | false | null)
//   - pulls.get(number).mergeable_state     ("clean" | "dirty" | "unknown" | ...)
//   - checks.listForRef(sha)                (array of {name, status, conclusion})
//   - merges.create(base, head)             (success | conflict-error)
//   - git.pushHead(branch, sha)             (records calls)
//   - actions.dispatchWorkflow(name, ref)   (records calls)
//
// A `FakeStrategy` that records invocations and returns a scripted outcome,
// so we can test the orchestrator without depending on any real strategy.

// ─── inspect(): pure read, never mutates ──────────────────────────────────

test("inspect returns 'clean' when mergeable=true")
  given pr with mergeable=true, mergeable_state="clean"
  expect resolver.inspect(pr) == { state: "clean" }
  expect FakeGitHub.merges.create not called   // proves purity

test("inspect returns 'unknown' when mergeable=null")
  given pr with mergeable=null
  expect resolver.inspect(pr).state == "unknown"
  // gate should poll again next tick, not act

test("inspect returns 'resolvable' when conflict is stale-base only")
  given pr where merging base into head would succeed cleanly
        (i.e. mergeable=false but no overlapping hunks)
  expect resolver.inspect(pr).state == "resolvable"
  expect resolver.inspect(pr).reason includes "stale base"

test("inspect returns 'unresolvable' for true semantic conflict")
  given pr where merging base into head produces a conflict marker
  expect resolver.inspect(pr).state == "unresolvable"

// ─── Strategy contract ────────────────────────────────────────────────────

test("merge-base-into-head strategy applies only to 'resolvable' PRs")
  given pr inspected as "unresolvable"
  expect strategy.canHandle(pr) == false

test("merge-base-into-head strategy pushes the merge commit")
  given pr inspected as "resolvable"
  when strategy.apply(pr)
  expect FakeGitHub.merges.create called with (pr.base, pr.head)
  expect FakeGitHub.git.pushHead called with new sha
  expect outcome == { outcome: "resolved", newHeadSha: <sha> }

test("strategy reports 'failed' when push is rejected")
  given push rejected (e.g. protected branch, race)
  expect outcome.outcome == "failed"
  expect outcome.log mentions rejection reason

// ─── attemptResolution(): orchestration ───────────────────────────────────

test("attemptResolution iterates strategies in order, stops at first match")
  given strategies [A (skips), B (resolves), C (would resolve)]
  expect B invoked, C NOT invoked
  expect returned outcome is B's outcome

test("attemptResolution returns 'skipped' when no strategy can handle")
  given strategies [A (skips), B (skips)]
  expect outcome.outcome == "skipped"

test("attemptResolution re-dispatches CI after a successful resolution")
  given strategy resolves to newHeadSha
  expect FakeGitHub.actions.dispatchWorkflow called with ("CI", branch)

test("feature flags gate strategy registration")
  given config with merge-base-into-head disabled
  expect that strategy not present in resolver's strategy list

// ─── Gate integration ─────────────────────────────────────────────────────
// These tests treat the resolver as a black box and verify the gate's
// new conditional logic.

test("gate keeps waiting on 'clean' PRs with in_progress Test check")
  // unchanged from today; baseline regression test

test("gate resolves 'resolvable' PR mid-loop and resumes waiting on new sha")
  given scopedPrs = [pr#21 resolvable, pr#20 clean+in_progress]
  when one poll iteration runs
  expect resolver.attemptResolution called with pr#21
  expect gate continues looping (does not exit, does not fail)
  expect next iteration polls Test check on pr#21's NEW head sha

test("gate flags 'unresolvable' PR and stops waiting on it")
  given pr#21 unresolvable
  expect gate emits structured log entry for pr#21
  expect gate's exit condition treats pr#21 as terminal (not pending)

test("gate respects the 20-minute timeout across resolution attempts")
  given resolver always returns "resolved" but Test check never completes
  expect gate exits at timeout with warning, not infinite loop

test("per-poll status table includes resolver actions")
  // satisfies mitigation (2) — verifies observability surface
  expect log contains a row per scoped PR with state + last resolver action
```

The test layering — `inspect` (pure), strategy (side-effectful but narrow), `attemptResolution` (orchestrator), gate integration (black-box) — is itself the abstraction boundary. If a test is hard to write at its layer, the abstraction is wrong; fix the shape before adding code.

### Recommended sequence

1. Ship (1) and (2) together as a single small PR to the action — fixes the immediate stall mode and makes future stalls self-diagnosing.
2. Add (6) — the pre-commit hook — to this consumer repo independently; no action changes required.
3. Build the in-loop auto-resolution behavior described above on top of (1)+(2). Start with the safe case (merge base into head when there is no real conflict), gated by a config flag, and let it bake before extending to richer resolution strategies.
4. Evaluate (3) and (4) once (1)+(2)+(3) have produced a few weeks of clearer logs.
5. Consider the broader form of (5) and (7) only if conflicts or rule-blocked PRs remain a recurring source of stalls after the above.
