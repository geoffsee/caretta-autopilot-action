# Post-Mortem: code-review 403 — dev_bot App not installed on `auto-pilot-example`

**Date:** 2026-05-15 | **Severity:** Low — single workflow run; no data loss | **Author:** @geoffsee

**Status:** Resolved (operator config)

## Summary

The autopilot work-dispatch route ran `caretta code-review 21` against the
`auto-pilot-example` repo. Inside caretta, `claude` attempted to submit a PR
review via `POST /repos/{owner}/{repo}/pulls/{n}/reviews` and received:

```
{"message":"Resource not accessible by integration","status":"403"}
```

The review payload was generated correctly and dropped to
`/tmp/review-21.json`; no review was posted.

## Impact

- One `code-review` step exited without posting its review.
- Downstream `fix-pr` did not have the review to act on, so the PR stayed at
  its prior state instead of receiving the requested changes.
- Run: `actions/runs/25923822740/job/76202319400`.

## Timeline

- **14:56 UTC** — Prior autopilot run completes cleanly; `gh pr update-branch`
  succeeds for all eight tracker PRs.
- **15:45 UTC** — Next autopilot run begins. `gh pr update-branch` flakes on four
  PRs with transient GitHub GraphQL errors; caretta posts conflict-resolution
  markers and continues (unrelated to this incident).
- **15:46 UTC** — `code-review 21` starts.
- **15:51 UTC** — `code-review` exits after the 403; review payload preserved on
  disk, no review posted to the PR.

## Root Cause

The dev_bot GitHub App was not installed on the `auto-pilot-example`
repository (or the repo was not in the App's "selected repositories" list).
The action materialized `DEV_BOT_PRIVATE_KEY_B64` and forwarded
`DEV_BOT_APP_ID` / `DEV_BOT_INSTALLATION_ID` to the caretta subprocess as
expected; caretta minted an installation access token; but the token's
installation had no access to the target repo, so any `pull_requests: write`
call returned 403.

The default `GITHUB_TOKEN` cannot post PR reviews either — even with
`permissions: pull-requests: write` — because GitHub explicitly blocks the
`github-actions[bot]` from creating reviews. The dev_bot App is therefore the
only viable identity for `code-review`. When its installation is missing the
target repo, there is no fallback that can succeed.

## Resolution

Added `auto-pilot-example` to the dev_bot GitHub App installation's
repository list. No code change required; next autopilot run authenticates
correctly.

## What Went Well

- `warnIfBotCredsIncomplete` in `execute.ts:81` already documents this exact
  failure mode ("expect HTTP 403 on code-review") for the related
  "installation id missing" case — pointed at the right area immediately.
- Claude's stop-on-permission-error behavior surfaced the 403 verbatim in the
  run log instead of retrying and burning credits.
- Review payload was preserved on disk, so no work was lost.

## What Went Poorly

- The action has no preflight that the configured App installation actually
  covers the repo it's about to operate on. The 403 only surfaces deep inside
  a 5-minute `code-review` run.
- Operator setup (adding repos to the App installation) is not part of any
  checklist or README section in this package — easy to miss when wiring up a
  new consumer repo.

## Action Items

| Action | Owner | Due |
|--------|-------|-----|
| Document the dev_bot App installation step in the README's setup section, including the "add target repos to the App" requirement and a link to the GitHub App settings page. | TODO | TODO |
| Consider a cheap preflight in `executeAutopilot`: when the work route is selected and bot creds are configured, hit `GET /repos/{owner}/{repo}/installation` with an App JWT and fail-fast with a clear error if the installation does not include the current repo. Cheaper than discovering the problem 5 minutes into `code-review`. | TODO | TODO |
| Revisit the reverted `mintInstallationToken` commit (`c068c43`) as the natural place to attach the preflight (JWT-signing primitives already present). | TODO | TODO |

---
*Blameless: this document examines systems and processes, not individuals.*
