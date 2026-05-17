import * as github from "@actions/github";
import {
  type ActionComposition,
  createActionComposition,
  runComposedAction,
} from "../../../action-common/src/action-composition.js";
import type { ActionRuntime } from "../../../action-common/src/action-runtime.js";
import type { GithubActionContext } from "../../../action-common/src/action-services.js";
import {
  defaultFactoryCycleMainDeps,
  FactoryCycleActionController,
  type FactoryCycleMainDeps,
} from "../presentation/github-action/controller.js";

export interface FactoryCycleCompositionOptions {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: GithubActionContext;
  readonly dependencies?: FactoryCycleMainDeps;
}

export function createFactoryCycleComposition(
  options: FactoryCycleCompositionOptions = {},
): ActionComposition {
  return createActionComposition(
    {
      githubContext: github.context,
      dependencies: defaultFactoryCycleMainDeps,
    },
    options,
  );
}

export async function runFactoryCycleAction(
  options: FactoryCycleCompositionOptions = {},
): Promise<void> {
  await runComposedAction(
    createFactoryCycleComposition(options),
    FactoryCycleActionController,
  );
}
