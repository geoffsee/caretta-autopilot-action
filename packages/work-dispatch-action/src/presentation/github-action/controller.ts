import { ACTION_COMPONENTS } from "@caretta/action-common/action-composition";
import type { ActionRuntime } from "@caretta/action-common/action-runtime";
import {
  type CarettaInstallDependencies,
  CarettaRuntimePreparer,
  GitHubActionPortFactory,
  type GitHubPortDependencies,
  prepareCarettaAction,
  readCarettaRuntimeInputs,
} from "@caretta/action-common/action-services";
import {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "@caretta/action-common/caretta-install";
import { DefaultExecClient as ProductionExecClient } from "@caretta/action-common/exec-client";
import { createOctokitClient as createProductionGitHubClient } from "@caretta/action-common/github-client";
import {
  Component as Inject,
  Container as InjectableWorkflow,
} from "di-framework/decorators";
import {
  DEFAULT_AGENT_BRANCH,
  DEFAULT_CI_TIMEOUT_MINUTES,
  DEFAULT_TEST_CHECK_NAME,
  parseTimeoutMinutes,
  TrackerLoopRunner,
} from "../../application/tracker-loop-runner.js";

export interface TrackerLoopDependencies
  extends GitHubPortDependencies,
    CarettaInstallDependencies {}

export const defaultTrackerLoopDependencies: TrackerLoopDependencies = {
  createGitHubClient: createProductionGitHubClient,
  createExecClient: () => new ProductionExecClient(),
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
};

@InjectableWorkflow({ singleton: false })
export class TrackerLoopWorkflow {
  constructor(
    @Inject(ACTION_COMPONENTS.actionRuntime)
    private readonly runtime: ActionRuntime,
    @Inject(GitHubActionPortFactory)
    private readonly ports: GitHubActionPortFactory,
    @Inject(CarettaRuntimePreparer)
    private readonly carettaRuntime: CarettaRuntimePreparer,
  ) {}

  async run(): Promise<void> {
    const carettaInputs = readCarettaRuntimeInputs(this.runtime);
    const tracker = this.runtime.getInput("tracker", { required: true });
    const agent = this.runtime.getInput("agent") || "claude";
    const testCheckName =
      this.runtime.getInput("test-check-name") || DEFAULT_TEST_CHECK_NAME;

    const agentBranchPatternInput =
      this.runtime.getInput("agent-branch-pattern") ||
      DEFAULT_AGENT_BRANCH.source;
    const agentBranchPattern = new RegExp(agentBranchPatternInput);

    const ciTimeoutMinutes = parseTimeoutMinutes(
      this.runtime.getInput("ci-timeout-minutes") ||
        String(DEFAULT_CI_TIMEOUT_MINUTES),
    );

    const { gh, exec, binaryPath, version, env } = await prepareCarettaAction(
      carettaInputs,
      this.ports,
      this.carettaRuntime,
    );

    const runner = new TrackerLoopRunner(binaryPath, env, exec, gh, {
      tracker,
      agent,
      testCheckName,
      agentBranchPattern,
      ciTimeoutMs: ciTimeoutMinutes * 60 * 1000,
    });

    const result = await runner.runTrackerLoop();

    this.runtime.setOutput("tracker", tracker);
    this.runtime.setOutput("issue_count", String(result.issueCount));
    this.runtime.setOutput("reviewed_pr_count", String(result.reviewedPrCount));
    this.runtime.setOutput("caretta_version", version);
  }
}

export async function main(
  deps: TrackerLoopDependencies = defaultTrackerLoopDependencies,
): Promise<void> {
  const { runWorkDispatchAction } = await import("../../composition/root.js");
  await runWorkDispatchAction({ dependencies: deps });
}
