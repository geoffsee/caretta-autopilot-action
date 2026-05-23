import * as github from "@actions/github";
import {
  type ActionComposition,
  createActionComposition,
  runComposedAction,
} from "@caretta/action-common/action-composition";
import type { ActionRuntime } from "@caretta/action-common/action-runtime";
import {
  type AutopilotDependencies,
  type AutopilotGithubActionContext,
  AutopilotWorkflow,
  defaultAutopilotDependencies,
} from "../presentation/github-action/controller.js";

export interface AutopilotCompositionOptions {
  readonly runtime?: ActionRuntime;
  readonly githubContext?: AutopilotGithubActionContext;
  readonly dependencies?: AutopilotDependencies;
}

export function createAutopilotComposition(
  options: AutopilotCompositionOptions = {},
): ActionComposition {
  return createActionComposition(
    {
      githubContext: github.context,
      dependencies: defaultAutopilotDependencies,
    },
    options,
  );
}

export async function runAutopilotAction(
  options: AutopilotCompositionOptions = {},
): Promise<void> {
  await runComposedAction(
    createAutopilotComposition(options),
    AutopilotWorkflow,
  );
}
