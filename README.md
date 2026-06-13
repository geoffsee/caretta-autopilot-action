# caretta-autopilot-action

[![CI](https://github.com/geoffsee/caretta-autopilot-action/actions/workflows/test.yml/badge.svg)](https://github.com/geoffsee/caretta-autopilot-action/actions/workflows/test.yml)
[![Runtime](https://img.shields.io/badge/runtime-node20-43853d?logo=node.js&logoColor=white)](action.yml)
[![Built with Bun](https://img.shields.io/badge/built%20with-bun-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![GitHub Action](https://img.shields.io/badge/GitHub-Action-2088FF?logo=githubactions&logoColor=white)](https://github.com/marketplace/actions)

> 🧭 A self-steering GitHub Action that reads your repository's pulse and picks the right autopilot route — every time it runs.

`caretta-autopilot-action` evaluates open issues and pull requests on each invocation and runs the appropriate autopilot route **inline**:

- 🏃 **Work dispatch** — when a sprint is active.
- 🏭 **Factory cycle** — when it isn't.

Before executing, it scans agent PRs (`agent/issue-*`) for a head-SHA `Test` check and dispatches `ci.yml` for any that need one — holding execution until those tests can attach to the current heads.

The action **self-gates** on the triggering event: subscribe broadly in your workflow YAML, and it will exit cleanly on events that don't move state (non-sprint issue activity, non-agent PRs, etc.).

---

## Table of contents

- [Quick start](#quick-start)
- [Setup guide](docs/SETUP.md)
- [How it works](#how-it-works)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Required permissions](#required-permissions)
- [Development](#development)
- [Local testing](#local-testing)
- [License](#license)

---

## Quick start

```yaml
- uses: actions/checkout@v4
- uses: geoffsee/caretta-autopilot-action@main
  with:
    context: "Autopilot scheduled evaluation"
    dry-run: "false"
    github-token: ${{ github.token }}
```

A complete example consumer repo lives at [`examples/autopilot-example-project/`](examples/autopilot-example-project). For a step-by-step walkthrough including the required CI workflow, local testing, and troubleshooting, see [`docs/SETUP.md`](docs/SETUP.md).

## How it works

```
┌────────────────────────┐
│  Triggering event      │  push · schedule · issues · PR · workflow_dispatch
└────────────┬───────────┘
             ▼
   ┌──────────────────┐    no-op events
   │   self-gate      │ ────────────────► exit cleanly
   └────────┬─────────┘
            ▼
   ┌──────────────────┐
   │  scan agent PRs  │ dispatch ci.yml for missing head-SHA Test checks
   └────────┬─────────┘
            ▼
   ┌──────────────────┐    active sprint?
   │   route picker   │ ──── yes ──► 🏃  work dispatch
   └────────┬─────────┘
            │ no
            ▼
                          🏭  factory cycle
```

## Inputs

| Input             | Default                                              | Description                                                                                                          |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `context`         | `Autopilot scheduled evaluation of open issues...`   | Natural-language steering context for the run.                                                                       |
| `dry-run`         | `false`                                              | Evaluate and report without executing caretta or dispatching CI.                                                     |
| `enable-dispatch` | `true`                                               | When `false`, evaluate and classify only; execute nothing.                                                           |
| `github-token`    | `${{ github.token }}`                                | Token for the GitHub API.                                                                                            |
| `caretta-version` | `latest`                                             | Caretta version to install.                                                                                          |
| `agent`           | `claude`                                             | Agent backend used by caretta.                                                                                       |
| `ci-workflow`     | `ci.yml`                                             | Workflow file dispatched per agent PR for the Test check.                                                            |
| `test-check-name` | `Test`                                               | Gate check name. Matches exactly, or GitHub Actions' `Workflow / job` form (e.g. `CI / Test` when the job id is `Test`). |
| `git-user-name`   | `caretta-autopilot[bot]`                             | Git author/committer name used when caretta creates commits.                                                         |
| `git-user-email`  | `caretta-autopilot[bot]@users.noreply.github.com`    | Git author/committer email used when caretta creates commits.                                                        |

### Codex agent (`agent: codex`)

For ChatGPT-managed Codex auth on ephemeral runners, seed `CODEX_AUTH_JSON` once from a trusted machine (`codex login` with `cli_auth_credentials_store = "file"`), then pass it to the action. The action restores `~/.codex/auth.json` before caretta runs and persists any refreshed tokens back to the secret after the job. See [OpenAI's CI/CD auth guide](https://developers.openai.com/codex/auth/ci-cd-auth).

```yaml
- uses: geoffsee/caretta-autopilot-action@main
  with:
    agent: codex
  env:
    CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
```

## Outputs

| Output              | Description                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `route`             | Selected route: `work` or `factory`.                                                     |
| `tracker`           | Sprint issue number used as tracker input, when a sprint was found.                      |
| `sprint`            | Same as `tracker`; preserved for compatibility.                                          |
| `reason`            | Human-readable reason for the route selection.                                           |
| `open_issue_count`  | Number of open issues.                                                                   |
| `open_pr_count`     | Number of open pull requests.                                                            |
| `stale_pr_count`    | Non-draft PRs whose review decision is `CHANGES_REQUESTED` or `REVIEW_REQUIRED`.         |
| `pending_count`     | Agent PRs that need a Test check on their head SHA.                                      |
| `dispatched_count`  | CI dispatches initiated this run.                                                        |
| `active_count`      | Agent PRs already running/queued CI for their head SHA.                                  |
| `current_count`     | Agent PRs whose head SHA already has a Test check.                                       |
| `failed_count`      | Agent PRs whose CI dispatch attempt failed.                                              |
| `hold_target`       | `true` when execution was held this pass.                                                |
| `target_dispatched` | Outcome: `executed` or `skipped`.                                                        |

## Required permissions

```yaml
permissions:
  actions: write         # dispatch ci.yml per agent PR
  checks: write          # read/update check state on PR head SHA
  statuses: write        # create commit statuses (Test pending/error/sync)
  contents: write        # caretta commits during execution
  issues: write          # caretta opens/edits issues
  pull-requests: write
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build   # bundles dist/index.js — must be committed
```

`action.yml` points at `dist/index.js`, so the bundled output is committed alongside the source. **Re-run `bun run build` after every change to `src/`.**

### Local testing

Run the action against the real GitHub API without committing or pushing using [`@github/local-action`](https://github.com/github/local-action):

```bash
# npx @github/local-action <action-yaml-path> <entrypoint> <dotenv-file>
npx @github/local-action . src/index.ts .env
```

The repo ships a starter `.env` (gitignored) — fill in `INPUT_GITHUB-TOKEN` before running. Keep `INPUT_DRY-RUN=true` and `INPUT_ENABLE-DISPATCH=false` until you're ready to actually execute. Setting `GITHUB_EVENT_NAME=workflow_dispatch` ensures the trigger gate lets the run through.

## License

Part of the [caretta](https://github.com/geoffsee/caretta) project. See repository for license details.
