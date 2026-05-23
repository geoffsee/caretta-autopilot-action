import * as github from "@actions/github";
import {
  type ActionComposition,
  createActionComposition,
  runComposedAction,
} from "@caretta/action-common/action-composition";
import type { ActionRuntime } from "@caretta/action-common/action-runtime";
import type { GithubActionContext } from "@caretta/action-common/action-services";
import {
  defaultFactoryCycleDependencies,
  type FactoryCycleDependencies,
  FactoryCycleWorkflow,
} from "../presentation/github-action/controller.js";

export interface FactoryCycleCompositionOptions {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: GithubActionContext;
  readonly dependencies?: FactoryCycleDependencies;
}

export function createFactoryCycleComposition(
  options: FactoryCycleCompositionOptions = {},
): ActionComposition {
  return createActionComposition(
    {
      githubContext: github.context,
      dependencies: defaultFactoryCycleDependencies,
    },
    options,
  );
}

export async function runFactoryCycleAction(
  options: FactoryCycleCompositionOptions = {},
): Promise<void> {
  await runComposedAction(
    createFactoryCycleComposition(options),
    FactoryCycleWorkflow,
  );
}
