import {
  Component as Inject,
  Container as InjectableWorkflow,
} from "di-framework/decorators";
import { ACTION_COMPONENTS } from "../../../packages/action-common/src/action-composition.js";
import type { ActionRuntime } from "../../../packages/action-common/src/action-runtime.js";
import {
  GitHubActionPortFactory,
  type GitHubPortDependencies,
  type GithubActionContext,
} from "../../../packages/action-common/src/action-services.js";
import { DefaultExecClient as ProductionExecClient } from "../../../packages/action-common/src/exec-client.js";
import { createOctokitClient as createProductionGitHubClient } from "../../../packages/action-common/src/github-client.js";
import {
  type AutopilotConfig,
  DEFAULT_AGENT_BRANCH,
} from "../../../packages/action-common/src/types.js";
import {
  AutopilotUseCase,
  type RunAutopilotUseCase,
} from "../../application/run-autopilot.js";
import { AutopilotDomainLogic } from "../../domain/autopilot-domain.js";

export interface AutopilotDependencies extends GitHubPortDependencies {
  readonly runAutopilotUseCase?: RunAutopilotUseCase;
}

export const defaultAutopilotDependencies: AutopilotDependencies = {
  createGitHubClient: createProductionGitHubClient,
  createExecClient: () => new ProductionExecClient(),
};

export interface AutopilotGithubActionContext extends GithubActionContext {
  readonly ref?: string;
  readonly eventName?: string;
  readonly payload?: Record<string, unknown>;
}

@InjectableWorkflow({ singleton: false })
export class AutopilotWorkflow {
  constructor(
    @Inject(ACTION_COMPONENTS.actionRuntime)
    private readonly runtime: ActionRuntime,
    @Inject(ACTION_COMPONENTS.githubContext)
    private readonly githubContext: AutopilotGithubActionContext,
    @Inject(ACTION_COMPONENTS.mainDependencies)
    private readonly deps: AutopilotDependencies,
    @Inject(GitHubActionPortFactory)
    private readonly ports: GitHubActionPortFactory,
    @Inject(AutopilotDomainLogic)
    private readonly domain: AutopilotDomainLogic,
    @Inject(AutopilotUseCase)
    private readonly autopilotUseCase: AutopilotUseCase,
  ) {}

  async run(): Promise<void> {
    const token = this.runtime.getInput("github-token", { required: true });
    const carettaVersion = this.runtime.getInput("caretta-version") || "latest";
    const agent = this.runtime.getInput("agent") || "claude";
    const context =
      this.runtime.getInput("context") ||
      "Autopilot scheduled evaluation of open issues and pull requests.";
    const dryRun = this.runtime.getBooleanInput("dry-run");
    const enableDispatch =
      this.runtime.getInput("enable-dispatch") === ""
        ? true
        : this.runtime.getBooleanInput("enable-dispatch");
    const ciWorkflow = this.runtime.getInput("ci-workflow") || "ci.yml";
    const testCheckName = this.runtime.getInput("test-check-name") || "Test";
    const gitUserName =
      this.runtime.getInput("git-user-name") || "caretta-autopilot[bot]";
    const gitUserEmail =
      this.runtime.getInput("git-user-email") ||
      "caretta-autopilot[bot]@users.noreply.github.com";

    const ref =
      this.githubContext.ref?.replace(/^refs\/heads\//, "") || "master";
    const trigger = this.domain.decideTrigger({
      eventName: this.githubContext.eventName ?? "",
      payload: (this.githubContext.payload ?? {}) as Record<string, unknown>,
      agentBranchPrefix: "agent/issue-",
    });

    if (!trigger.run) {
      this.runtime.info(`autopilot: skipping (${trigger.reason})`);
      await this.runtime.summary
        .addRaw(`### Autopilot skipped\n\n_${trigger.reason}_\n`)
        .write();
      return;
    }
    this.runtime.info(`autopilot: running (${trigger.reason})`);

    const config: AutopilotConfig = {
      carettaVersion,
      agent,
      context,
      dryRun,
      enableDispatch,
      ciWorkflow,
      agentBranchPattern: DEFAULT_AGENT_BRANCH,
      testCheckName,
      githubToken: token,
      gitUserName,
      gitUserEmail,
    };

    const { gh, exec } = this.ports.create(token);
    const runAutopilotUseCase: RunAutopilotUseCase =
      this.deps.runAutopilotUseCase ??
      ((gh, exec, config, ref) =>
        this.autopilotUseCase.run(gh, exec, config, ref));
    const result = await runAutopilotUseCase(gh, exec, config, ref);

    this.runtime.setOutput("route", result.evaluation.route);
    this.runtime.setOutput("tracker", result.evaluation.tracker);
    this.runtime.setOutput(
      "sprint",
      result.evaluation.sprint?.toString() ?? "",
    );
    this.runtime.setOutput(
      "open_issue_count",
      String(result.evaluation.openIssueCount),
    );
    this.runtime.setOutput(
      "open_pr_count",
      String(result.evaluation.openPrCount),
    );
    this.runtime.setOutput(
      "stale_pr_count",
      String(result.evaluation.stalePrCount),
    );
    this.runtime.setOutput("reason", result.evaluation.reason);
    this.runtime.setOutput("pending_count", String(result.prCi.pending.length));
    this.runtime.setOutput(
      "dispatched_count",
      String(result.prCi.dispatched.length),
    );
    this.runtime.setOutput("active_count", String(result.prCi.active.length));
    this.runtime.setOutput("current_count", String(result.prCi.current.length));
    this.runtime.setOutput("failed_count", String(result.prCi.failed.length));
    this.runtime.setOutput("hold_target", String(result.decision.holdTarget));
    this.runtime.setOutput(
      "target_dispatched",
      result.decision.targetDispatched,
    );

    await this.runtime.summary.addRaw(result.summary).write();
  }
}

export async function main(
  deps: AutopilotDependencies = defaultAutopilotDependencies,
): Promise<void> {
  const { runAutopilotAction } = await import("../../composition/root.js");
  await runAutopilotAction({ dependencies: deps });
}
