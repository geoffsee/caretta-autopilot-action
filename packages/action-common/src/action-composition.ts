import type { Container as FrameworkComposition } from "di-framework/container";
import { useContainer as useActionComposition } from "di-framework/container";
import { type ActionRuntime, GitHubActionsRuntime } from "./action-runtime.js";

export type ActionComposition = FrameworkComposition;

export const ACTION_COMPONENTS = {
  actionRuntime: "githubAction.actionRuntime",
  githubContext: "githubAction.githubContext",
  mainDependencies: "githubAction.mainDependencies",
} as const;

export interface ActionCompositionOptions<TContext, TDependencies> {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: TContext;
  readonly dependencies?: TDependencies;
}

export interface ActionCompositionDefaults<TContext, TDependencies> {
  readonly githubContext: TContext;
  readonly dependencies: TDependencies;
}

export interface RunnableActionWorkflow {
  run(): Promise<void>;
}

export type ActionWorkflowConstructor<
  TWorkflow extends RunnableActionWorkflow,
> = new (
  ...args: never[]
) => TWorkflow;

export function createActionComposition<TContext, TDependencies>(
  defaults: ActionCompositionDefaults<TContext, TDependencies>,
  options: ActionCompositionOptions<TContext, TDependencies> = {},
): ActionComposition {
  const composition = useActionComposition().fork({ carrySingletons: false });
  composition.registerFactory(
    ACTION_COMPONENTS.actionRuntime,
    () => options.runtime ?? new GitHubActionsRuntime(),
    { singleton: true },
  );
  composition.registerFactory(
    ACTION_COMPONENTS.githubContext,
    () => options.githubContext ?? defaults.githubContext,
    { singleton: true },
  );
  composition.registerFactory(
    ACTION_COMPONENTS.mainDependencies,
    () => options.dependencies ?? defaults.dependencies,
    { singleton: true },
  );
  return composition;
}

export async function runComposedAction<
  TWorkflow extends RunnableActionWorkflow,
>(
  composition: ActionComposition,
  workflow: ActionWorkflowConstructor<TWorkflow>,
): Promise<void> {
  const resolved = composition.resolve(
    workflow as Parameters<FrameworkComposition["resolve"]>[0],
  ) as TWorkflow;
  await resolved.run();
}
