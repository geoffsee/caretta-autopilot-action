import * as github from "@actions/github";
import type { Container as DIContainer } from "di-framework/container";
import type { ActionRuntime } from "../../packages/action-common/src/action-runtime.js";
import {
  ACTION_TOKENS,
  createActionContainer,
} from "../../packages/action-common/src/di-container.js";
import {
  AutopilotActionController,
  type AutopilotGithubActionContext,
  defaultDependencies,
  type MainDependencies,
} from "../presentation/github-action/controller.js";

export interface AutopilotContainerOptions {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: AutopilotGithubActionContext;
  readonly dependencies?: MainDependencies;
}

export function createAutopilotContainer(
  options: AutopilotContainerOptions = {},
): DIContainer {
  return createActionContainer(
    ACTION_TOKENS,
    {
      githubContext: github.context,
      dependencies: defaultDependencies,
    },
    options,
  );
}

export async function runAutopilotAction(
  options: AutopilotContainerOptions = {},
): Promise<void> {
  const container = createAutopilotContainer(options);
  const controller = container.resolve(AutopilotActionController);
  await controller.run();
}
