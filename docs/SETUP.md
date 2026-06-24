# Setup

This guide walks through installing `caretta-autopilot-action` in a consumer repository and verifying it runs end-to-end.

## Prerequisites

- A GitHub repository where you can add workflows.
- Permission to set repository secrets and adjust workflow permissions.
- A **GitHub App** to act as the bot identity (see [§1](#1-create-the-bot-github-app)). The default `GITHUB_TOKEN` cannot post pull-request reviews — GitHub blocks `github-actions[bot]` from `POST /pulls/{n}/reviews` — so caretta needs an App-minted installation token for `code-review`.
- A Claude OAuth token for the underlying agent.
- (Local development only) [Bun](https://bun.sh) ≥ 1.0 and Node 20+.

## 1. Create the bot GitHub App

caretta authenticates as a GitHub App so it can post PR reviews and commit on behalf of a bot identity. Create one once and reuse it across consumer repos.

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App** (organization-level if multiple repos will use it).
2. Configure these **Repository permissions** (Read & write unless noted):
   - Actions, Checks, Statuses, Contents, Issues, Pull requests
   - Metadata (Read-only, mandatory)
3. Leave webhooks disabled — the action polls; no events are needed.
4. Create the App, then:
   - Note the **App ID** (numeric).
   - **Generate a private key** and download the `.pem` file.
5. **Install the App** on the target repo(s): App page → *Install App* → select the consumer repo(s). The App must be installed on *every* repo the autopilot will operate on, or `code-review` will fail with `HTTP 403 Resource not accessible by integration`.
6. Capture the **Installation ID** from the URL after install (`https://github.com/settings/installations/<INSTALLATION_ID>`) or via:

   ```bash
   gh api /users/<bot-app-slug>/installation --jq .id
   ```

7. Base64-encode the private key for storage as a secret:

   ```bash
   base64 -i path/to/private-key.pem | pbcopy   # macOS
   base64 -w0 path/to/private-key.pem            # Linux
   ```

## 2. Set repository secrets

Add the following under **Settings → Secrets and variables → Actions** in the consumer repo (or at the org level if shared):

| Secret                      | Purpose                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`   | OAuth token for the Claude agent backend.                                                     |
| `DEV_BOT_APP_ID`            | Numeric App ID from §1.                                                                       |
| `DEV_BOT_INSTALLATION_ID`   | Installation ID from §1. **Required** — without it, caretta falls back to `GITHUB_TOKEN` and `code-review` will 403. |
| `DEV_BOT_PRIVATE_KEY_B64`   | Base64-encoded `.pem` from §1. Decoded into a temp file on the runner and re-exported as `DEV_BOT_PRIVATE_KEY`.       |
| `CODEX_AUTH_JSON`           | Required when `agent: codex` — contents of `~/.codex/auth.json` from a trusted `codex login`. The action restores and persists this automatically. |

> The action emits a warning when `DEV_BOT_APP_ID` and `DEV_BOT_PRIVATE_KEY` are present but `DEV_BOT_INSTALLATION_ID` is missing — watch for it in the job log on first run.

### Codex (`agent: codex`)

ChatGPT-managed Codex auth on ephemeral GitHub-hosted runners needs an `auth.json` round-trip. The action handles restore/persist when you pass `CODEX_AUTH_JSON`; you only seed the secret once:

```bash
# On a trusted machine with browser login:
codex login
gh secret set CODEX_AUTH_JSON < "${CODEX_HOME:-$HOME/.codex}/auth.json" --repo your-org/your-repo
```

## 3. Add the workflow

Create `.github/workflows/autopilot.yml` in your repository:

```yaml
name: Autopilot

on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:
  issues:
    types: [opened, edited, labeled, closed, reopened]
  pull_request:
    types: [opened, synchronize, reopened, closed, ready_for_review]

permissions:
  actions: write
  checks: write
  statuses: write
  contents: write
  issues: write
  pull-requests: write

jobs:
  autopilot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: geoffsee/caretta-autopilot-action@main
        with:
          context: "Autopilot scheduled evaluation"
          geodynamo-url: ${{ vars.GEODYNAMO_URL }}
          dry-run: "false"
          github-token: ${{ github.token }}
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          DEV_BOT_APP_ID: ${{ secrets.DEV_BOT_APP_ID }}
          DEV_BOT_INSTALLATION_ID: ${{ secrets.DEV_BOT_INSTALLATION_ID }}
          DEV_BOT_PRIVATE_KEY_B64: ${{ secrets.DEV_BOT_PRIVATE_KEY_B64 }}
```

The action self-gates on the triggering event, so subscribing broadly is safe — irrelevant events exit cleanly.

`geodynamo-url` is optional and overrides project configuration. For the usual
project-level setup, declare the managing geodynamo Pages root once in
`caretta.toml`:

```toml
geodynamo_url = "https://geoffsee.github.io/geodynamo/"
```

When the action input is absent, autopilot reads top-level `geodynamo_url` from
the checked-out repository's `caretta.toml`; when both are absent it uses
`https://geoffsee.github.io/geodynamo/`. Factory cycles derive
`contexts/<current-repo-name>/context.json` from the resolved root and apply the
context only on the `factory` route. Work-dispatch cycles keep using only the
normal `context` input.

Also enable **Settings → Actions → General → Read and write permissions** and **Allow GitHub Actions to create and approve pull requests** so the `github.token` used for gating CI dispatches and check updates has the rights it needs.

## 4. Ensure a CI workflow named `Test` exists

The autopilot expects each agent PR (`agent/issue-*`) to have a check named `Test` on its head SHA. If you do not already have one, add `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  workflow_dispatch:
  pull_request:
  push:

jobs:
  Test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "replace with your test command"
```

If your check name differs, set `test-check-name` on the action. Both `Test` and `CI / Test` (workflow-prefixed) forms are matched.

## 5. Configure inputs (optional)

| Input             | When to change                                                  |
| ----------------- | --------------------------------------------------------------- |
| `context`         | Tailor the natural-language steering for your project.          |
| `geodynamo-url`   | Temporarily override `caretta.toml`'s `geodynamo_url`.          |
| `dry-run`         | Set `true` during initial rollout to observe without executing. |
| `enable-dispatch` | Set `false` to classify only — useful for diagnostics.          |
| `ci-workflow`     | Point at your CI workflow file if it is not `ci.yml`.           |
| `test-check-name` | Match your existing check name.                                 |
| `agent`           | Swap the underlying caretta agent backend.                      |

See [`README.md`](../README.md#inputs) for the full table.

## 6. Verify the first run

1. Trigger the workflow manually from the **Actions** tab (`Run workflow`).
2. Inspect the job summary — the action prints the chosen route (`work` or `factory`) and the reason.
3. Confirm that agent PRs receive a `Test` check on their head SHA within one autopilot cycle.

If the job exits with `route=none`, the self-gate decided the event was a no-op. That is expected for events that do not move repository state.

## 7. Local development

Clone this repository and install dependencies:

```bash
bun install
bun run typecheck
bun test
bun run build
```

`action.yml` resolves to `dist/index.js`, so the bundle must be committed after any change under `src/`.

### Running against the real GitHub API

Use [`@github/local-action`](https://github.com/github/local-action) to execute the entrypoint locally without committing:

```bash
npx @github/local-action . src/index.ts .env
```

Populate `.env` with at least:

```dotenv
INPUT_GITHUB-TOKEN=ghp_xxx
INPUT_DRY-RUN=true
INPUT_ENABLE-DISPATCH=false
GITHUB_EVENT_NAME=workflow_dispatch
GITHUB_REPOSITORY=your-org/your-repo

# Bot App identity — same secrets as the production workflow
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...
DEV_BOT_APP_ID=123456
DEV_BOT_INSTALLATION_ID=78901234
DEV_BOT_PRIVATE_KEY_B64=LS0tLS1CRUdJTi...  # base64 of the .pem
```

Keep `dry-run` on and `enable-dispatch` off until you have validated the classification output.

## Troubleshooting

- **`code-review` exits with `HTTP 403 Resource not accessible by integration`.** The bot GitHub App is not installed on this repo, or the repo is missing from the App's "selected repositories" list. Add it under *App settings → Install App → Configure*.
- **Job log warns about `DEV_BOT_INSTALLATION_ID is missing`.** caretta is falling back to `GITHUB_TOKEN`, which cannot post PR reviews. Set the secret and forward it under `env:`.
- **PRs sit blocked on a missing `Test` check.** Confirm `ci-workflow` matches your workflow file and that the workflow defines a job whose check name resolves to `test-check-name`.
- **Action exits immediately.** The self-gate filtered the event. Trigger via `workflow_dispatch` or `schedule` to force a full evaluation.
- **Permission errors on `actions`/`checks`/`statuses`.** Re-check the `permissions:` block — those three writes are required for the gating logic regardless of which token is used.
