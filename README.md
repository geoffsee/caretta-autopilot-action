# caretta-autopilot-action

GitHub Action that evaluates a repository's open issues and pull requests and runs the appropriate autopilot route inline: **work dispatch** when a sprint is active, **factory cycle** otherwise. Before running, it scans agent PRs (`agent/issue-*`) for a head-SHA `Test` check and dispatches `ci.yml` for any that need one — holding execution until those tests can attach to the current heads.

The action also self-gates on the triggering event: subscribe broadly in your workflow YAML, and the action exits cleanly on events that don't move state (non-sprint issue activity, non-agent PRs, etc.).

## Usage

```yaml
- uses: actions/checkout@v4
- uses: geoffsee/caretta-autopilot-action@main
  with:
    context: "Autopilot scheduled evaluation"
    dry-run: "false"
    github-token: ${{ github.token }}
```

A complete example consumer repo lives at [`examples/autopilot-example-project/`](examples/autopilot-example-project).

## Inputs

| Input             | Default               | Description                                                  |
| ----------------- | --------------------- | ------------------------------------------------------------ |
| `context`         | (built-in message)    | Natural-language steering context for the run.               |
| `dry-run`         | `false`               | Evaluate and report without executing caretta or dispatching CI. |
| `enable-dispatch` | `true`                | When false, evaluate and classify only; execute nothing.     |
| `github-token`    | `${{ github.token }}` | Token for the GitHub API.                                    |
| `caretta-version` | `latest`              | Caretta version to install.                                  |
| `agent`           | `claude`              | Agent backend used by caretta.                               |
| `ci-workflow`     | `ci.yml`              | Workflow file dispatched per agent PR for the Test check.    |

## Outputs

`route` (`work`|`factory`), `tracker`, `sprint`, `open_issue_count`, `open_pr_count`, `stale_pr_count`, `reason`, `pending_count`, `dispatched_count`, `active_count`, `current_count`, `failed_count`, `hold_target`, `target_dispatched` (`executed`|`skipped`).

## Required permissions

```yaml
permissions:
  actions: write   # dispatch ci.yml per agent PR
  checks: write    # read/update check state on PR head SHA
  statuses: write  # create commit statuses (Test pending/error/sync)
  contents: write  # caretta commits during execution
  issues: write    # caretta opens/edits issues
  pull-requests: write
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build   # bundles dist/index.js — must be committed
```

`action.yml` points at `dist/index.js`, so the bundled output is committed alongside the source. Re-run `bun run build` after every change to `src/`.

### Local testing

Run the action against the real GitHub API without committing or pushing using [`@github/local-action`](https://github.com/github/local-action):

```bash
# npx @github/local-action <action-yaml-path> <entrypoint> <dotenv-file>
npx @github/local-action . src/index.ts .env
```

The repo ships a starter `.env` (gitignored) — fill in `INPUT_GITHUB-TOKEN` before running. Keep `INPUT_DRY-RUN=true` and `INPUT_ENABLE-DISPATCH=false` until you're ready to actually execute. `GITHUB_EVENT_NAME=workflow_dispatch` ensures the trigger gate lets the run through.
