# caretta-autopilot-action

GitHub Action that evaluates a repository's open issues and pull requests and dispatches the appropriate autopilot follow-up workflow (tracker loop when a sprint is active, factory cycle otherwise). Before dispatching the target workflow, it scans agent PRs (`agent/issue-*`) for a head-SHA `Test` check and dispatches `ci.yml` for any that need one — gating the target workflow until those tests can attach to the current heads.

This action replaces the long bash/jq evaluate-and-dispatch step previously inlined in `autopilot.yml`. The logic lives in plain TypeScript with unit tests against a fake Octokit; the workflow file becomes a thin orchestration wrapper.

## Usage

```yaml
- uses: actions/checkout@v4
- uses: geoffsee/caretta-autopilot-action@main
  with:
    context: "Autopilot scheduled evaluation"
    dry-run: "false"
    github-token: ${{ github.token }}
```

## Inputs

| Input              | Default                      | Description                                                                    |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------ |
| `context`          | (built-in message)           | Natural-language steering context forwarded to the dispatched target workflow. |
| `dry-run`          | `false`                      | Evaluate and report without dispatching.                                       |
| `github-token`     | `${{ github.token }}`        | Token for the GitHub API.                                                      |
| `tracker-workflow` | `tracker-loop-dispatch.yml`  | File dispatched when a sprint is found.                                        |
| `factory-workflow` | `factory-cycle-dispatch.yml` | File dispatched when no sprint is found.                                       |
| `ci-workflow`      | `ci.yml`                     | File dispatched per agent PR.                                                  |

## Outputs

`workflow`, `tracker`, `sprint`, `open_issue_count`, `open_pr_count`, `stale_pr_count`, `reason`, `pending_count`, `dispatched_count`, `active_count`, `current_count`, `failed_count`, `hold_target`, `target_dispatched`.

## Required permissions

```yaml
permissions:
  actions: write # dispatch workflows
  checks: read # read Test check on PR head SHA
  contents: read
  issues: read
  pull-requests: read
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build   # bundles dist/index.js — must be committed
```

`action.yml` points at `dist/index.js`, so the bundled output is committed alongside the source. Re-run `bun run build` after every change to `src/`.
