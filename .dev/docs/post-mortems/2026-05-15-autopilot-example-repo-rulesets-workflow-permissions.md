# Post-Mortem: Branch rulesets and workflow permissions on autopilot-example-project

**Date:** 2026-05-15 | **Severity:** TODO | **Author:** TODO

**Status:** Active — decisions are in effect; follow-ups open

**Last updated:** 2026-05-15 — `all` ruleset rules stripped (now empty); see below.

## Summary

Two branch rulesets and a permissive workflow-permissions configuration were enabled on `geoffsee/autopilot-example-project`. Together they raise the floor for what is allowed to land — PRs required and a passing `Test` check required to merge into `main`, linear history on `main`, no force-push or deletion — while keeping the `GITHUB_TOKEN` broad enough that the autopilot can continue to push branches, open PRs, and (potentially) approve them. The combination achieves the intended safety properties for code reaching `main`, but it leaves a small number of sharp edges that are worth naming explicitly so they aren't rediscovered during an incident.

As of 2026-05-15T12:07Z, the `all` ruleset has been emptied of rules — it still exists and is `active`, but enforces nothing. The original entry below has been updated to reflect this; the historical configuration is preserved under "Original configuration (now removed)" for context. All gating on `main` now comes from the `default` ruleset alone; `agent/*` and other non-default branches are no longer gated by repository rulesets.

## Impact

- TODO — This entry documents intentional repository configuration and sharp edges, not a discrete outage; no user-visible impact window is recorded here.

## Timeline

- TODO — Key configuration milestones (including emptying the `all` ruleset) are described narratively under **Last updated** above and **## What changed** below; clock times were not kept for this write-up beyond the `2026-05-15T12:07Z` note in **Summary**.

## Root Cause

- TODO — Not framed as a single failure event; rationale for the posture is under **Why these settings are in place** in **## What changed** below.

## What Went Well

- TODO

## What Went Poorly

- TODO

## Action Items

| Action | Owner | Due |
|--------|-------|-----|
| Tighten default workflow permissions (repo default read + explicit per-workflow `permissions:`). | TODO | TODO |
| Decide intentionally on the "Allow GHA to create and approve PRs" toggle; document which workflows may use it. | TODO | TODO |
| Encode the `Test` check name once (shared source of truth across workflow, rulesets, `runCiGate`). | TODO | TODO |
| Add a periodic drift check (scheduled workflow or autopilot step) comparing live rulesets to a checked-in JSON file. | TODO | TODO |
| Consider downgrading Admin bypass to `pull_request` mode if direct pushes to `main` should remain blocked. | TODO | TODO |
| Consider deleting the empty `all` ruleset if it stays a no-op long-term. | TODO | TODO |
| Ship `caretta verify-config` + expectations file (see **Recommended solution** below). | TODO | TODO |

## What changed

### Ruleset `all` (id 16452040) — targets `~ALL` branches, enforcement: active

**Current configuration (as of 2026-05-15T12:07Z):**

- `rules: []` — the ruleset is active but enforces no rules.
- **Bypass:** Repository Admin role, mode `always` (unchanged).
- Conditions still target `~ALL` branches with no excludes.

Effect: the ruleset is a no-op. No PR is required to merge into `agent/*` or any other non-default branch, and no status check is required there. All gating on the `main` branch comes from the `default` ruleset below; gating on every other branch comes from nothing.

**Original configuration (now removed):**

- **Pull request required** (`required_approving_review_count: 0`, all merge methods allowed: `squash`, `rebase`, `merge`)
- **Required status check:** `Test` (GitHub Actions integration `15368`), `strict_required_status_checks_policy: false`
- **Bypass:** Repository Admin role, mode `always`

Original effect: every branch in the repo — including `agent/issue-*` — required a PR with a passing `Test` check to merge. Direct pushes to a branch tip were still allowed (the `pull_request` rule gates *merging into* the target ref, not pushes that create or advance non-target refs), but no branch could be the *destination* of a merge except via PR.

This was removed to close risk #3 below (heavier than the goal required) and to reduce friction on autopilot branch operations. The `default` ruleset continues to provide all of the safety properties that actually matter for `main`.

### Ruleset `default` (id 16451528) — targets `~DEFAULT_BRANCH`, enforcement: active

- **Block deletion**
- **Block non-fast-forward** (no force-push to `main`)
- **Pull request required** (`required_approving_review_count: 1`, `squash` and `rebase` only — no merge commits)
- **Required status check:** `Test`
- **Required linear history**
- **Bypass:** Repository Admin role, mode `always`

Effect: `main` is the strictest ref in the repo — one approving review, linear history, no force push, no deletion, passing `Test`.

### Workflow permissions (repository settings)

- **Default token permissions:** Read and write — every workflow in the repo gets a `GITHUB_TOKEN` with write access across all scopes unless it narrows that explicitly in YAML.
- **Allow GitHub Actions to create and approve pull requests:** enabled.

Effect: the autopilot workflow has the token authority it needs to push branches, open PRs, comment, and (via the new permission) approve PRs without an additional PAT or App credential.

## Why these settings are in place

- **Quality floor for `main`.** The required `Test` check turns the autopilot's existing CI gate from advisory to enforced — PRs cannot merge red, regardless of who is driving.
- **Audit trail.** Requiring PRs into `main` means every change to the production branch is reviewable in the PRs tab. (The original `all` ruleset extended this to every branch; that was reverted because the cost outweighed the benefit on `agent/*` branches — see the "Original configuration" subsection above.)
- **Clean history.** Linear history + squash/rebase-only on `main` keeps `git log main` legible — important for an autopilot-driven repo where many small agent PRs land in quick succession.
- **Autopilot enablement.** The broad token + "create and approve" toggle is what allows the action to function end-to-end without an external bot identity.

## Implications for the autopilot

- **The autopilot's CI gate now has teeth for merges into `main`.** Previously a PR with a missing or red `Test` check could still be merged manually; now it cannot. Stalls of the form described in `2026-05-15-autopilot-runci-gate-poll-stall-on-merge-conflict.md` are no longer a soft failure for `main` — they directly translate to merge blockers. (Merges *into* `agent/*` branches no longer hit a ruleset gate since the `all` ruleset was emptied; the autopilot's own `runCiGate` still enforces `Test` in software, independent of GitHub rulesets.)
- **Bypass relies on Admin role, not the bot identity.** The bypass actor for both rulesets is the Repository Admin *role* (actor_id 5, RepositoryRole). `GITHUB_TOKEN` runs as the GitHub Actions identity, which is *not* in that role. The autopilot does not get bypass for `main` — it must satisfy the `default` ruleset like any other contributor. This is the right default for safety. Operations on non-default branches are no longer rule-gated at all (the `all` ruleset is empty), so the autopilot moves freely on `agent/*` branches.
- **Stacked agent PRs are constrained at the merge-into-`main` step only.** When an agent PR's base is another agent branch (e.g., `#21 → agent/issue-6`), the intermediate merge no longer needs to satisfy a ruleset — only the eventual merge into `main` does. The autopilot still needs to account for the retarget step explicitly, because the merge into `main` will require the retargeted PR's `Test` to be green against the new base.
- **`strict_required_status_checks_policy: false` is load-bearing.** Because we did *not* require branches to be up-to-date with base before merging, the autopilot can land PRs in any order without each one having to be rebased onto the latest `main` first. Flipping this to `true` later would meaningfully change autopilot throughput.

## Risks and sharp edges

### 1. Workflows have write permissions by default

"Read and write permissions" is the broadest default. Any workflow in this repo — including ones that don't need write — runs with a token that can modify code, create releases, and push to branches. The CI workflow only needs read; the autopilot is the only one that needs write. The current configuration over-grants by default and would let a compromised or accidentally-broad workflow do real damage.

### 2. "Allow GitHub Actions to create and approve pull requests" + 1-approval requirement on `main`

The default-branch ruleset requires one approving review. The repo-level toggle permits GitHub Actions to *submit* approving reviews. GitHub historically does not count `GITHUB_TOKEN`-authored reviews from the same workflow run that pushed the commit, but cross-workflow approvals (workflow A pushes; workflow B approves) are a documented gray area and have changed behavior across product updates. Operationally: a workflow we don't expect to approve PRs is, today, technically permitted to do so. The bypass-via-Admin path achieves the same outcome with clearer intent.

### 3. `pull_request` rule on `~ALL` is broader than it needs to be — **resolved 2026-05-15T12:07Z**

Requiring a PR to merge into *every* branch was heavier than the goal (gate `main`) required. For `agent/*` branches, the rule mostly produced friction without adding safety — no human is reviewing merges into an agent branch, and the autopilot is the only writer.

This was resolved by emptying the `all` ruleset's rules entirely (rather than narrowing the include pattern, which was the alternative considered). The `default` ruleset continues to gate `main`. Trade-off: the audit-trail-everywhere property is gone, and any future long-lived branches that need protection will require a new ruleset rather than inheriting from `all`. Kept in the doc as resolved rather than removed so the prior state is recoverable.

### 4. The `Test` check name is a wire-format dependency

The `default` ruleset pins the required check by literal name `Test`. The autopilot uses the same literal in `runCiGate`. Renaming the job in `.github/workflows/ci.yml` will silently break both the gate *and* the merge requirement. There is no test or lint catching this drift. (The `all` ruleset previously also pinned `Test`; with that ruleset now empty, only one source remains to keep in sync — but the drift risk on that single source is unchanged.)

### 5. Bypass mode `always` for Admin

Admin bypass is `always`, not `pull_request` or audit-only. An admin pushing directly to `main` would succeed and bypass the `Test` check entirely. For a single-maintainer repo this is acceptable; for a team repo it would be a foot-gun.

### 6. Auto-merge queue stalls when `update-branch` advances tips — **resolved 2026-05-15**

The work-dispatch loop's step 14 runs `caretta auto-merge --automerge-queue`, which in turn calls `gh pr update-branch` on each tracker-scoped PR before enabling auto-merge. When `main` has moved since the PR last ran CI, that fast-forwards the head ref to a new SHA. The `Test` check from the preceding `runCiGate` step (step 13) is attached to the *prior* SHA, so the new tip has no `Test` check. The `default` ruleset's `required_status_checks` rule then keeps auto-merge waiting on a check that nothing will dispatch — the queue sits idle until something else fires CI.

Observed on 2026-05-15 on `autopilot-example-project`: after `auto-merge --automerge-queue` ran, 4 of 5 tracker PRs (#15, #16, #17, #20) had auto-merge enabled and were APPROVED but stuck at `mergeStateStatus: BLOCKED`. None of the new tips had any `Test` check. Manual fix at the time was `gh workflow run ci.yml --ref agent/issue-N` for each branch.

Patched in `src/execute.ts:runWorkDispatch` by calling `dispatchMissingCi` once more as step 15, after the `--automerge-queue` step. The helper inspects each PR's current head SHA, skips any that already have a `Test` check or an in-flight workflow run at that SHA, and dispatches `ciWorkflow` for the rest. Cost: one extra round of GitHub API calls per pass; benefit: the queue drains without manual intervention. Covered by a regression test in `tests/execute.test.ts` ("work dispatch fires CI after automerge-queue advances the branch tip") that simulates the SHA-advance via an inline `FakeExec` hook and asserts a dispatch lands for the advanced tip.

This is the third instance of the same shape that already appears at steps 5 and 12 — a caretta sub-command advances the tip, and the next gate needs a fresh CI run. The pattern suggests `caretta auto-merge --automerge-queue` should arguably do the dispatch itself (one-stop-shop in the CLI rather than scattered across the action wrapper). Tracked as a future improvement; not blocking.

## Mitigations and follow-ups

- **Tighten default workflow permissions.** Switch the repository default to "Read repository contents and packages permissions" and declare `permissions:` blocks explicitly in each workflow that needs more. The autopilot workflow opts into `contents: write`, `pull-requests: write`, `checks: write` at the job level; the CI workflow stays read-only.
- **Decide intentionally on the "Allow GHA to create and approve PRs" toggle.** If approvals from automation are not part of the design, disable the toggle and rely on Admin bypass (or a dedicated bot account) for any case where automation must merge without human review. If approvals from automation *are* part of the design, document which workflows are expected to use them.
- ~~**Narrow the `all` ruleset.**~~ **Done (2026-05-15T12:07Z) — but more aggressively than originally proposed.** The `all` ruleset was emptied of rules entirely rather than narrowed to a smaller include pattern. The ruleset itself is still active (with the same `~ALL` target and Admin bypass) so it can be re-populated later without recreating it. Consider deleting it outright if it stays empty long-term, since an empty active ruleset is a confusing artifact in the GitHub UI.
- **Encode the `Test` check name once.** Move the literal `"Test"` to a single source of truth (e.g., a `.github/required-checks.yml` or a constant in the action) and reference it from the workflow, the rulesets, and `runCiGate`. Either generate the ruleset payload from it or add a CI step that diffs the configured check name against the workflow job name and fails on drift.
- **Add a periodic drift check.** A scheduled workflow (or a step inside the existing autopilot run) that fetches the rulesets via `gh api` and compares them to a checked-in JSON file. Surfaces accidental changes to enforcement, bypass actors, or required checks — none of which are otherwise visible in code review.
- **Consider downgrading Admin bypass to `pull_request` mode.** This keeps Admin's ability to merge without review *via PR* but blocks direct pushes to `main`. Closes risk #5 without removing the escape hatch.

## Recommended solution: a caretta self-test for repository configuration

Most of the risks above share the same shape: the autopilot's behavior depends on repository state (rulesets, required checks, workflow permissions, bypass actors) that lives outside the codebase, isn't versioned, and isn't reviewed when it changes. The way to close the loop is for caretta itself to ship a **self-test** that verifies the live repository configuration aligns with what the autopilot needs to function safely.

### What it verifies

The self-test would assert, against the GitHub API, a concrete set of expectations for the repository it is running in. Examples:

- A ruleset exists for the default branch with `enforcement: active`.
- That ruleset includes a `required_status_checks` rule whose contexts contain the check name caretta's gate is configured to wait on (today: `Test`).
- That ruleset includes a `pull_request` rule (i.e., direct pushes to `main` are blocked).
- Bypass actors on the default-branch ruleset match a declared allow-list (e.g., Admin role only, not arbitrary users or apps).
- Workflow permissions either match a declared baseline, or — preferably — are read-only at the repo level, with write permissions declared explicitly per workflow.
- The "Allow GitHub Actions to create and approve pull requests" toggle matches the declared intent (on or off, but not "drifted").
- The required check context name matches the job name in `.github/workflows/ci.yml` (closes risk #4 — drift between the wire-format dependency and the workflow).

### How it should be packaged

- A first-class command in caretta (e.g., `caretta doctor` or `caretta verify-config`) that runs the checks and prints a structured report — green/yellow/red per assertion, with the offending API payload and a remediation hint on each failure.
- An expectations file checked into the consumer repo (e.g., `.caretta/expected-config.yml`) declaring the contract: which check names are required, which bypass actors are allowed, which workflow-permission posture is intended. The self-test compares the live state to this file, so the contract is reviewable in code review and changes are visible in `git log`.
- A reusable GitHub Action wrapper so consumers can run it as a scheduled workflow (e.g., daily) and/or as a step at the top of the autopilot run itself.

### When it runs

Two cadences, doing different jobs:

1. **Inline at the start of every autopilot run.** Before entering `runCiGate` or any state-mutating phase, run the self-test. If a required ruleset is missing, the required check name has drifted, or workflow permissions don't match expectations, fail fast with a single clear log line instead of stalling later for an obscure reason. Cheap (a handful of API calls), high-leverage.
2. **As a scheduled workflow (e.g., nightly).** Catches drift that happens outside an autopilot run — someone tightens a ruleset, removes a bypass actor, renames a check — *before* it manifests as a stuck job. On failure, opens (or updates) a single tracking issue rather than spamming on every run.

### What it does on mismatch

- **Inline mode:** fail the autopilot step with a structured error naming the failed assertion, the expected value, the observed value, and the API endpoint to inspect. No remediation attempts — config drift is operator-grade, not autopilot-grade.
- **Scheduled mode:** open or update a tracking issue with the same payload, labelled (e.g., `caretta:config-drift`) so it is greppable.

### Why this is the right shape

- **Turns the implicit contract into an explicit one.** Today, the autopilot encodes assumptions about ruleset and permission state in prose (this document) and in failure modes (the stall described in the other post-mortem). The self-test makes those assumptions executable.
- **Catches drift at the source.** Most of the failure modes above — renamed check, removed status requirement, broadened bypass, accidentally-toggled permission — are silent today and noisy under a self-test.
- **Composes with the conflict-resolver work in the sibling post-mortem.** Both efforts share the same instinct: move the autopilot from "polls until something happens" to "knows what it expects and reports when reality disagrees." The self-test is the configuration-layer instance of that pattern; the resolver is the PR-state-layer instance.
- **No new privileges required.** The same `GITHUB_TOKEN` the autopilot already has (with `metadata: read` and `administration: read` where needed) is sufficient to read rulesets, branch protections, and workflow permissions.

### Suggested rollout

1. Define the expectations file format and ship `caretta verify-config` as a no-op-by-default command that prints the report.
2. Add a single scheduled workflow in this repo that runs it nightly and opens a tracking issue on failure.
3. Once the report is stable, wire it in as the first step of the autopilot run with `--fail-on-mismatch`.
4. Optionally, generate the expectations file *from* the live config on first run, so adopters get a working baseline without hand-authoring YAML.

---
*Blameless: this document examines systems and processes, not individuals.*
