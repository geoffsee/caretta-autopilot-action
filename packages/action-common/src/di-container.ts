import type { Container as DIContainer } from "di-framework/container";
import { useContainer } from "di-framework/container";
import { type ActionRuntime, GitHubActionsRuntime } from "./action-runtime.js";

export const ACTION_TOKENS = {
  actionRuntime: "githubAction.actionRuntime",
  githubContext: "githubAction.githubContext",
  mainDependencies: "githubAction.mainDependencies",
} as const;

export interface ActionContainerTokens {
  readonly actionRuntime: string;
  readonly githubContext: string;
  readonly mainDependencies: string;
}

export interface ActionContainerOptions<TContext, TDependencies> {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: TContext;
  readonly dependencies?: TDependencies;
}

export interface ActionContainerDefaults<TContext, TDependencies> {
  readonly githubContext: TContext;
  readonly dependencies: TDependencies;
}

export function createActionContainer<TContext, TDependencies>(
  tokens: ActionContainerTokens,
  defaults: ActionContainerDefaults<TContext, TDependencies>,
  options: ActionContainerOptions<TContext, TDependencies> = {},
): DIContainer {
  const container = useContainer().fork({ carrySingletons: false });
  container.registerFactory(
    tokens.actionRuntime,
    () => options.runtime ?? new GitHubActionsRuntime(),
    { singleton: true },
  );
  container.registerFactory(
    tokens.githubContext,
    () => options.githubContext ?? defaults.githubContext,
    { singleton: true },
  );
  container.registerFactory(
    tokens.mainDependencies,
    () => options.dependencies ?? defaults.dependencies,
    { singleton: true },
  );
  return container;
}
