import * as github from "@actions/github";
import type { Container as DIContainer } from "di-framework/container";
import type { ActionRuntime } from "../../../action-common/src/action-runtime.js";
import type { GithubActionContext } from "../../../action-common/src/action-services.js";
import {
  ACTION_TOKENS,
  createActionContainer,
} from "../../../action-common/src/di-container.js";
import {
  defaultTrackerLoopMainDeps,
  TrackerLoopActionController,
  type TrackerLoopMainDeps,
} from "../presentation/github-action/controller.js";

export interface WorkDispatchContainerOptions {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: GithubActionContext;
  readonly dependencies?: TrackerLoopMainDeps;
}

export function createWorkDispatchContainer(
  options: WorkDispatchContainerOptions = {},
): DIContainer {
  return createActionContainer(
    ACTION_TOKENS,
    {
      githubContext: github.context,
      dependencies: defaultTrackerLoopMainDeps,
    },
    options,
  );
}

export async function runWorkDispatchAction(
  options: WorkDispatchContainerOptions = {},
): Promise<void> {
  const container = createWorkDispatchContainer(options);
  await container.resolve(TrackerLoopActionController).run();
}
