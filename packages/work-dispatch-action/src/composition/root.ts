import * as github from "@actions/github";
import {
  type ActionComposition,
  createActionComposition,
  runComposedAction,
} from "../../../action-common/src/action-composition.js";
import type { ActionRuntime } from "../../../action-common/src/action-runtime.js";
import type { GithubActionContext } from "../../../action-common/src/action-services.js";
import {
  defaultTrackerLoopDependencies,
  type TrackerLoopDependencies,
  TrackerLoopWorkflow,
} from "../presentation/github-action/controller.js";

export interface WorkDispatchCompositionOptions {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: GithubActionContext;
  readonly dependencies?: TrackerLoopDependencies;
}

export function createWorkDispatchComposition(
  options: WorkDispatchCompositionOptions = {},
): ActionComposition {
  return createActionComposition(
    {
      githubContext: github.context,
      dependencies: defaultTrackerLoopDependencies,
    },
    options,
  );
}

export async function runWorkDispatchAction(
  options: WorkDispatchCompositionOptions = {},
): Promise<void> {
  await runComposedAction(
    createWorkDispatchComposition(options),
    TrackerLoopWorkflow,
  );
}
