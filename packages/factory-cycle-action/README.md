# @caretta/factory-cycle-action

TypeScript GitHub Action that runs the factory cycle logic that used to live in `factory-cycle-dispatch.yml`.

## Usage

```yaml
- uses: geoffsee/caretta-autopilot-action/packages/factory-cycle-action@main
  with:
    context: "Autopilot factory cycle"
    github-token: ${{ github.token }}
```
