# @caretta/work-dispatch-action

TypeScript GitHub Action that runs the tracker loop logic that used to live in `tracker-loop-dispatch.yml`.

## Usage

```yaml
- uses: geoffsee/caretta-autopilot-action/packages/work-dispatch-action@main
  with:
    tracker: "1234"
    context: "Autopilot tracker loop"
    github-token: ${{ github.token }}
```
