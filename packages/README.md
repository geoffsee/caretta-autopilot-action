# Action Packages

This directory scaffolds TypeScript GitHub Actions that replace the legacy dispatch workflow bodies:

- `INPUT_TRACKER-WORKFLOW=tracker-loop-dispatch.yml` -> `packages/work-dispatch-action`
- `INPUT_FACTORY-WORKFLOW=factory-cycle-dispatch.yml` -> `packages/factory-cycle-action`

## Package layout

- `work-dispatch-action`: Runs tracker loop logic (tracker-matrix, issue loop, sync, conflict fix, CI gate, review/fix, automerge queue).
- `factory-cycle-action`: Runs factory cycle logic (housekeeping, sprint preflight, ideation, research, strategic review, sprint planning).

## Wrapper workflow migration

If your autopilot control plane still dispatches workflow files, keep thin wrapper workflows named `tracker-loop-dispatch.yml` and `factory-cycle-dispatch.yml` and call these actions from them.

Tracker wrapper example:

```yaml
name: Tracker Loop Dispatch
on:
  workflow_dispatch:
    inputs:
      tracker:
        required: true
        type: string
      context:
        required: false
        type: string
      model:
        required: false
        type: string
jobs:
  run:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      checks: write
      contents: write
      issues: write
      pull-requests: write
      statuses: write
    steps:
      - uses: actions/checkout@v4
      - uses: geoffsee/caretta-autopilot-action/packages/work-dispatch-action@main
        with:
          tracker: ${{ inputs.tracker }}
          context: ${{ inputs.context }}
          model: ${{ inputs.model }}
          github-token: ${{ github.token }}
```

Factory wrapper example:

```yaml
name: Factory Cycle Dispatch
on:
  workflow_dispatch:
    inputs:
      context:
        required: false
        type: string
      model:
        required: false
        type: string
jobs:
  run:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      checks: write
      contents: write
      issues: write
      pull-requests: write
      statuses: write
    steps:
      - uses: actions/checkout@v4
      - uses: geoffsee/caretta-autopilot-action/packages/factory-cycle-action@main
        with:
          context: ${{ inputs.context }}
          model: ${{ inputs.model }}
          github-token: ${{ github.token }}
```
