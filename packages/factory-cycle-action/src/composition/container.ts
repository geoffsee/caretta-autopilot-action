import * as github from "@actions/github";
import type { Container as DIContainer } from "di-framework/container";
import type { ActionRuntime } from "../../../action-common/src/action-runtime.js";
import type { GithubActionContext } from "../../../action-common/src/action-services.js";
import {
  ACTION_TOKENS,
  createActionContainer,
} from "../../../action-common/src/di-container.js";
import {
  defaultFactoryCycleMainDeps,
  FactoryCycleActionController,
  type FactoryCycleMainDeps,
} from "../presentation/github-action/controller.js";

export interface FactoryCycleContainerOptions {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: GithubActionContext;
  readonly dependencies?: FactoryCycleMainDeps;
}

export function createFactoryCycleContainer(
  options: FactoryCycleContainerOptions = {},
): DIContainer {
  return createActionContainer(
    ACTION_TOKENS,
    {
      githubContext: github.context,
      dependencies: defaultFactoryCycleMainDeps,
    },
    options,
  );
}

export async function runFactoryCycleAction(
  options: FactoryCycleContainerOptions = {},
): Promise<void> {
  const container = createFactoryCycleContainer(options);
  await container.resolve(FactoryCycleActionController).run();
}
