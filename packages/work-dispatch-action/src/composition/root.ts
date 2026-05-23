import * as github from "@actions/github";
import {
  type ActionComposition,
  createActionComposition,
  runComposedAction,
} from "@caretta/action-common/action-composition";
import type { ActionRuntime } from "@caretta/action-common/action-runtime";
import type { GithubActionContext } from "@caretta/action-common/action-services";
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
