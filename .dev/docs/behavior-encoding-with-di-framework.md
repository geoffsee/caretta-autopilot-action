# Behavior Encoding With di-framework

This refactor uses `di-framework` to compose GitHub Action behavior and the
autopilot domain policy model for each action invocation.

The important rule is:

> Domain and application code encode behavior. `di-framework` models the
> domain policies as injectable objects and chooses the concrete runtime
> collaborators used for one action invocation.

## Layer Responsibilities

Behavior is split across these layers:

- `domain/`: policies and decisions. The pure function exports remain the
  canonical behavior; injectable policy classes and `AutopilotDomainLogic`
  model those policies for `di-framework`. Domain files do not import GitHub
  Actions APIs, Octokit, or process state.
- `application/`: use cases and orchestration. `AutopilotUseCase` receives the
  injectable domain model and runtime ports like `GitHubClient` and
  `ExecClient`; it does not resolve its own dependencies.
- `presentation/github-action/`: action workflows. These translate GitHub
  Action inputs, context, and outputs into application calls.
- `composition/root.ts`: action composition roots. These create a fresh
  `ActionComposition` for a single invocation and resolve the top-level
  controller.
- `packages/action-common/src`: shared ports, adapters, action runtime helpers,
  and composition helpers used by all three actions.

The domain rules remain ordinary TypeScript:

- Trigger behavior: `src/domain/trigger.ts`
- Evaluation behavior: `src/domain/evaluate.ts`
- Execution decision behavior: `src/domain/decide.ts`
- Summary behavior: `src/domain/summary.ts`
- Autopilot orchestration: `src/application/run-autopilot.ts`
- Work dispatch orchestration:
  `packages/work-dispatch-action/src/application/tracker-loop-runner.ts`
- Factory cycle orchestration:
  `packages/factory-cycle-action/src/application/factory-cycle-runner.ts`

## What di-framework Encodes

`di-framework` encodes object wiring and domain policy object boundaries, not
the branch conditions themselves.

Shared composition identifiers live in
`packages/action-common/src/action-composition.ts`:

```ts
export const ACTION_COMPONENTS = {
  actionRuntime: "githubAction.actionRuntime",
  githubContext: "githubAction.githubContext",
  mainDependencies: "githubAction.mainDependencies",
} as const;
```

Those identifiers describe action-level collaborators:

- `actionRuntime`: the GitHub Actions runtime facade. Production uses
  `GitHubActionsRuntime`; tests can provide a fake runtime.
- `githubContext`: the GitHub context for this invocation.
- `mainDependencies`: production factories and optional test-supplied use-case
  overrides, such as `createGitHubClient`, `createExecClient`,
  `installCaretta`, and `runAutopilotUseCase`.

The composition helper creates a fresh framework composition for every action
run:

```ts
const composition = useContainer().fork({ carrySingletons: false });
```

The per-invocation values are registered as singleton factories inside that
fresh composition. Workflows, shared services, use cases, and domain policies
are declared with non-singleton decorators, so resolving the same action in
separate composition roots does not leak state between tests or action
invocations.

## Constructor Injection

Workflows and shared edge services declare their dependencies in
constructors:

```ts
@InjectableWorkflow({ singleton: false })
export class AutopilotWorkflow {
  constructor(
    @Inject(ACTION_COMPONENTS.actionRuntime)
    private readonly runtime: ActionRuntime,
    @Inject(ACTION_COMPONENTS.githubContext)
    private readonly githubContext: AutopilotGithubActionContext,
    @Inject(ACTION_COMPONENTS.mainDependencies)
    private readonly deps: AutopilotDependencies,
    @Inject(GitHubActionPortFactory)
    private readonly ports: GitHubActionPortFactory,
  ) {}
}
```

This keeps dependency selection explicit:

- The workflow does not import `@actions/core` directly.
- The workflow does not construct Octokit directly.
- The workflow does not construct an exec adapter directly.
- Tests can replace all external effects by passing fake values to the
  composition root.

The same pattern is used by work-dispatch and factory-cycle workflows. Shared
services such as `GitHubActionPortFactory` and `CarettaRuntimePreparer` also use
constructor injection so the common GitHub/Caretta setup is not duplicated in
each action.

Domain policy classes use the same constructor injection pattern:

```ts
@InjectableDomainModel({ singleton: false })
export class AutopilotDomainLogic {
  constructor(
    @Inject(TriggerPolicy)
    private readonly triggers: TriggerPolicy,
    @Inject(EvaluationPolicy)
    private readonly evaluation: EvaluationPolicy,
    @Inject(ExecutionDecisionPolicy)
    private readonly decisions: ExecutionDecisionPolicy,
    @Inject(SummaryPolicy)
    private readonly summaries: SummaryPolicy,
  ) {}
}
```

The methods delegate to the same pure functions that behavior tests exercise
directly.

## Invocation Flow

For each action, the runtime path is:

1. `src/index.ts` calls the action workflow `main()` function and handles the
   final error boundary.
2. `main()` delegates to that action's `composition/root.ts`.
3. The composition root calls `createActionComposition(...)` with production
   defaults and any test overrides.
4. `runComposedAction(...)` resolves the top-level workflow.
5. The workflow reads action inputs and GitHub context through injected
   collaborators.
6. The workflow calls the injected domain model for trigger decisions.
7. The workflow calls either a test-supplied run use case or the injected
   `AutopilotUseCase`.
8. `AutopilotUseCase` coordinates repository reads, PR CI processing, and the
   injected domain model's evaluation, execution decision, and summary policy.
9. Outputs and summaries are written through the injected `ActionRuntime`.

The root autopilot action composes:

- `AutopilotWorkflow`
- `AutopilotUseCase`
- `AutopilotDomainLogic`
- `TriggerPolicy`
- `EvaluationPolicy`
- `ExecutionDecisionPolicy`
- `SummaryPolicy`
- `GitHubActionPortFactory`
- `AutopilotDependencies`
- `ActionRuntime`
- `AutopilotGithubActionContext`

The work-dispatch action composes:

- `TrackerLoopWorkflow`
- `GitHubActionPortFactory`
- `CarettaRuntimePreparer`
- `TrackerLoopDependencies`
- `ActionRuntime`
- `GithubActionContext`

The factory-cycle action composes:

- `FactoryCycleWorkflow`
- `GitHubActionPortFactory`
- `CarettaRuntimePreparer`
- `FactoryCycleDependencies`
- `ActionRuntime`
- `GithubActionContext`

## Behavior Stability

The public action behavior is preserved because the decision branches remain in
the same pure functions. `di-framework` supplies the policy objects that expose
those functions to the composed workflow and use case.

For example, the root action still decides whether to run by calling
`AutopilotDomainLogic.decideTrigger(...)`, which delegates to
`decideTrigger(...)`. It still evaluates repository state through
`AutopilotUseCase.run(...)`, which delegates to the same evaluation, decision,
and summary functions through the injected domain model.

Production runtime defaults are declared next to each workflow:

```ts
export const defaultAutopilotDependencies: AutopilotDependencies = {
  createGitHubClient: createProductionGitHubClient,
  createExecClient: () => new ProductionExecClient(),
};
```

Tests can still pass `runAutopilotUseCase` into `create*Composition(...)` to
exercise the same workflow path without network, subprocess, or GitHub Actions
side effects. When that override is omitted, the use case is resolved through
`di-framework`.

## Test Encoding

The composition tests prove these things:

- The top-level workflow resolves with fake runtime ports.
- The autopilot domain model resolves through `di-framework` policy classes.
- Separate composition roots do not share workflow instances or singleton
  state.

The behavior tests continue to target domain and application modules directly.
That is intentional: behavior should be testable without `di-framework`.

Use composition tests to validate wiring. Use domain/application tests to
validate decisions and orchestration.

## Boundaries To Preserve

Keep these rules intact when adding behavior:

- Domain `di-framework` usage should stay limited to decorators on policy
  classes and constructor injection on the aggregate domain model.
- Do not resolve dependencies inside `domain/` or `application/`.
- Do not add service-location calls outside composition helpers.
- Add new runtime collaborators as constructor dependencies on workflows or
  shared edge services.
- Add production factories to the action's `default*Deps` object.
- Add new domain behavior as a pure function first, then expose it through an
  injectable policy class or `AutopilotDomainLogic`.
- Add test fakes through `create*Composition(...)` options.

This keeps the semantic DDD boundary clear: the domain says what should happen,
the application coordinates it, and the composition root chooses the concrete
tools used to run it inside GitHub Actions.
