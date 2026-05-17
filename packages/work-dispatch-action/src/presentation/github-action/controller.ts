import { Component, Container } from "di-framework/decorators";
import { ACTION_COMPONENTS } from "../../../../action-common/src/action-composition.js";
import type { ActionRuntime } from "../../../../action-common/src/action-runtime.js";
import {
  type CarettaInstallDependencies,
  CarettaRuntimePreparer,
  GitHubActionPortFactory,
  type GitHubPortDependencies,
  prepareCarettaAction,
  readCarettaRuntimeInputs,
} from "../../../../action-common/src/action-services.js";
import {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "../../../../action-common/src/caretta-install.js";
import { DefaultExecClient } from "../../../../action-common/src/exec-client.js";
import { createOctokitClient } from "../../../../action-common/src/github-client.js";
import {
  DEFAULT_AGENT_BRANCH,
  DEFAULT_CI_TIMEOUT_MINUTES,
  DEFAULT_TEST_CHECK_NAME,
  parseTimeoutMinutes,
  TrackerLoopRunner,
} from "../../application/tracker-loop-runner.js";

export interface TrackerLoopMainDeps
  extends GitHubPortDependencies,
    CarettaInstallDependencies {}

export const defaultTrackerLoopMainDeps: TrackerLoopMainDeps = {
  createGitHubClient: createOctokitClient,
  createExecClient: () => new DefaultExecClient(),
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
};

@Container({ singleton: false })
export class TrackerLoopActionController {
  constructor(
    @Component(ACTION_COMPONENTS.actionRuntime)
    private readonly runtime: ActionRuntime,
    @Component(GitHubActionPortFactory)
    private readonly ports: GitHubActionPortFactory,
    @Component(CarettaRuntimePreparer)
    private readonly carettaRuntime: CarettaRuntimePreparer,
  ) {}

  async run(): Promise<void> {
    await runWithRuntime(this.runtime, this.ports, this.carettaRuntime);
  }
}

export async function main(
  deps: TrackerLoopMainDeps = defaultTrackerLoopMainDeps,
): Promise<void> {
  const { runWorkDispatchAction } = await import("../../composition/root.js");
  await runWorkDispatchAction({ dependencies: deps });
}

async function runWithRuntime(
  runtime: ActionRuntime,
  ports: GitHubActionPortFactory,
  carettaRuntime: CarettaRuntimePreparer,
): Promise<void> {
  const carettaInputs = readCarettaRuntimeInputs(runtime);
  const tracker = runtime.getInput("tracker", { required: true });
  const agent = runtime.getInput("agent") || "claude";
  const testCheckName =
    runtime.getInput("test-check-name") || DEFAULT_TEST_CHECK_NAME;

  const agentBranchPatternInput =
    runtime.getInput("agent-branch-pattern") || DEFAULT_AGENT_BRANCH.source;
  const agentBranchPattern = new RegExp(agentBranchPatternInput);

  const ciTimeoutMinutes = parseTimeoutMinutes(
    runtime.getInput("ci-timeout-minutes") ||
      String(DEFAULT_CI_TIMEOUT_MINUTES),
  );

  const { gh, exec, binaryPath, version, env } = await prepareCarettaAction(
    carettaInputs,
    ports,
    carettaRuntime,
  );

  const runner = new TrackerLoopRunner(binaryPath, env, exec, gh, {
    tracker,
    agent,
    testCheckName,
    agentBranchPattern,
    ciTimeoutMs: ciTimeoutMinutes * 60 * 1000,
  });

  const result = await runner.runTrackerLoop();

  runtime.setOutput("tracker", tracker);
  runtime.setOutput("issue_count", String(result.issueCount));
  runtime.setOutput("reviewed_pr_count", String(result.reviewedPrCount));
  runtime.setOutput("caretta_version", version);
}
