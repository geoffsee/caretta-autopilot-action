import { Component, Container } from "di-framework/decorators";
import { ACTION_COMPONENTS } from "../../../packages/action-common/src/action-composition.js";
import type { ActionRuntime } from "../../../packages/action-common/src/action-runtime.js";
import {
  GitHubActionPortFactory,
  type GitHubPortDependencies,
  type GithubActionContext,
} from "../../../packages/action-common/src/action-services.js";
import type { ExecClient } from "../../../packages/action-common/src/exec-client.js";
import { DefaultExecClient } from "../../../packages/action-common/src/exec-client.js";
import type { GitHubClient } from "../../../packages/action-common/src/github-client.js";
import { createOctokitClient } from "../../../packages/action-common/src/github-client.js";
import {
  type AutopilotConfig,
  DEFAULT_AGENT_BRANCH,
  DEFAULT_TEST_CHECK_NAME,
} from "../../../packages/action-common/src/types.js";
import type { AutopilotRunResult } from "../../application/run-autopilot.js";
import { runAutopilot } from "../../application/run-autopilot.js";
import { decideTrigger } from "../../domain/trigger.js";

export interface MainDependencies extends GitHubPortDependencies {
  readonly runAutopilot: (
    gh: GitHubClient,
    exec: ExecClient,
    config: AutopilotConfig,
    ref: string,
  ) => Promise<AutopilotRunResult>;
}

export const defaultDependencies: MainDependencies = {
  createGitHubClient: createOctokitClient,
  createExecClient: () => new DefaultExecClient(),
  runAutopilot,
};

export interface AutopilotGithubActionContext extends GithubActionContext {
  readonly ref?: string;
  readonly eventName?: string;
  readonly payload?: Record<string, unknown>;
}

@Container({ singleton: false })
export class AutopilotActionController {
  constructor(
    @Component(ACTION_COMPONENTS.actionRuntime)
    private readonly runtime: ActionRuntime,
    @Component(ACTION_COMPONENTS.githubContext)
    private readonly githubContext: AutopilotGithubActionContext,
    @Component(ACTION_COMPONENTS.mainDependencies)
    private readonly deps: MainDependencies,
    @Component(GitHubActionPortFactory)
    private readonly ports: GitHubActionPortFactory,
  ) {}

  async run(): Promise<void> {
    await runWithRuntime(
      this.runtime,
      this.githubContext,
      this.deps,
      this.ports,
    );
  }
}

export async function main(
  deps: MainDependencies = defaultDependencies,
): Promise<void> {
  const { runAutopilotAction } = await import("../../composition/root.js");
  await runAutopilotAction({ dependencies: deps });
}

async function runWithRuntime(
  runtime: ActionRuntime,
  ctx: AutopilotGithubActionContext,
  deps: MainDependencies,
  ports: GitHubActionPortFactory,
): Promise<void> {
  const token = runtime.getInput("github-token", { required: true });
  const carettaVersion = runtime.getInput("caretta-version") || "latest";
  const agent = runtime.getInput("agent") || "claude";
  const context =
    runtime.getInput("context") ||
    "Autopilot scheduled evaluation of open issues and pull requests.";
  const dryRun = runtime.getBooleanInput("dry-run");
  const enableDispatch =
    runtime.getInput("enable-dispatch") === ""
      ? true
      : runtime.getBooleanInput("enable-dispatch");
  const ciWorkflow = runtime.getInput("ci-workflow") || "ci.yml";
  const gitUserName =
    runtime.getInput("git-user-name") || "caretta-autopilot[bot]";
  const gitUserEmail =
    runtime.getInput("git-user-email") ||
    "caretta-autopilot[bot]@users.noreply.github.com";

  const ref = ctx.ref?.replace(/^refs\/heads\//, "") || "master";

  const trigger = decideTrigger({
    eventName: ctx.eventName ?? "",
    payload: (ctx.payload ?? {}) as Record<string, unknown>,
    agentBranchPrefix: "agent/issue-",
  });
  if (!trigger.run) {
    runtime.info(`autopilot: skipping (${trigger.reason})`);
    await runtime.summary
      .addRaw(`### Autopilot skipped\n\n_${trigger.reason}_\n`)
      .write();
    return;
  }
  runtime.info(`autopilot: running (${trigger.reason})`);

  const config: AutopilotConfig = {
    carettaVersion,
    agent,
    context,
    dryRun,
    enableDispatch,
    ciWorkflow,
    agentBranchPattern: DEFAULT_AGENT_BRANCH,
    testCheckName: DEFAULT_TEST_CHECK_NAME,
    githubToken: token,
    gitUserName,
    gitUserEmail,
  };

  const { gh, exec } = ports.create(token);
  const result = await deps.runAutopilot(gh, exec, config, ref);

  runtime.setOutput("route", result.evaluation.route);
  runtime.setOutput("tracker", result.evaluation.tracker);
  runtime.setOutput("sprint", result.evaluation.sprint?.toString() ?? "");
  runtime.setOutput(
    "open_issue_count",
    String(result.evaluation.openIssueCount),
  );
  runtime.setOutput("open_pr_count", String(result.evaluation.openPrCount));
  runtime.setOutput("stale_pr_count", String(result.evaluation.stalePrCount));
  runtime.setOutput("reason", result.evaluation.reason);
  runtime.setOutput("pending_count", String(result.prCi.pending.length));
  runtime.setOutput("dispatched_count", String(result.prCi.dispatched.length));
  runtime.setOutput("active_count", String(result.prCi.active.length));
  runtime.setOutput("current_count", String(result.prCi.current.length));
  runtime.setOutput("failed_count", String(result.prCi.failed.length));
  runtime.setOutput("hold_target", String(result.decision.holdTarget));
  runtime.setOutput("target_dispatched", result.decision.targetDispatched);

  await runtime.summary.addRaw(result.summary).write();
}
