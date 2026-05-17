import type { Container as FrameworkComposition } from "di-framework/container";
import { useContainer } from "di-framework/container";
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

export interface RunnableActionController {
  run(): Promise<void>;
}

export type ActionControllerConstructor<
  TController extends RunnableActionController,
> = new (
  ...args: never[]
) => TController;

export function createActionComposition<TContext, TDependencies>(
  defaults: ActionCompositionDefaults<TContext, TDependencies>,
  options: ActionCompositionOptions<TContext, TDependencies> = {},
): ActionComposition {
  const composition = useContainer().fork({ carrySingletons: false });
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
  TController extends RunnableActionController,
>(
  composition: ActionComposition,
  controller: ActionControllerConstructor<TController>,
): Promise<void> {
  const resolved = composition.resolve(
    controller as Parameters<FrameworkComposition["resolve"]>[0],
  ) as TController;
  await resolved.run();
}
