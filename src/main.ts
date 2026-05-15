import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ExecClient } from "./exec.js";
import { DefaultExecClient } from "./exec.js";
import type { GitHubClient } from "./github.js";
import { createOctokitClient } from "./github.js";
import type { AutopilotRunResult } from "./run.js";
import { runAutopilot } from "./run.js";
import { decideTrigger } from "./trigger.js";
import {
  type AutopilotConfig,
  DEFAULT_AGENT_BRANCH,
  DEFAULT_TEST_CHECK_NAME,
} from "./types.js";

export interface MainDependencies {
  readonly createGitHubClient: (
    token: string,
    owner: string,
    repo: string,
  ) => GitHubClient;
  readonly createExecClient: () => ExecClient;
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

export async function main(
  deps: MainDependencies = defaultDependencies,
): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const carettaVersion = core.getInput("caretta-version") || "latest";
  const agent = core.getInput("agent") || "claude";
  const context =
    core.getInput("context") ||
    "Autopilot scheduled evaluation of open issues and pull requests.";
  const dryRun = core.getBooleanInput("dry-run");
  const enableDispatch =
    core.getInput("enable-dispatch") === ""
      ? true
      : core.getBooleanInput("enable-dispatch");
  const ciWorkflow = core.getInput("ci-workflow") || "ci.yml";

  const ctx = github.context;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const ref = ctx.ref?.replace(/^refs\/heads\//, "") || "master";

  const trigger = decideTrigger({
    eventName: ctx.eventName ?? "",
    payload: (ctx.payload ?? {}) as Record<string, unknown>,
    agentBranchPrefix: "agent/issue-",
  });
  if (!trigger.run) {
    core.info(`autopilot: skipping (${trigger.reason})`);
    await core.summary
      .addRaw(`### Autopilot skipped\n\n_${trigger.reason}_\n`)
      .write();
    return;
  }
  core.info(`autopilot: running (${trigger.reason})`);

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
  };

  const gh = deps.createGitHubClient(token, owner, repo);
  const exec = deps.createExecClient();
  const result = await deps.runAutopilot(gh, exec, config, ref);

  core.setOutput("route", result.evaluation.route);
  core.setOutput("tracker", result.evaluation.tracker);
  core.setOutput("sprint", result.evaluation.sprint?.toString() ?? "");
  core.setOutput("open_issue_count", String(result.evaluation.openIssueCount));
  core.setOutput("open_pr_count", String(result.evaluation.openPrCount));
  core.setOutput("stale_pr_count", String(result.evaluation.stalePrCount));
  core.setOutput("reason", result.evaluation.reason);
  core.setOutput("pending_count", String(result.prCi.pending.length));
  core.setOutput("dispatched_count", String(result.prCi.dispatched.length));
  core.setOutput("active_count", String(result.prCi.active.length));
  core.setOutput("current_count", String(result.prCi.current.length));
  core.setOutput("failed_count", String(result.prCi.failed.length));
  core.setOutput("hold_target", String(result.decision.holdTarget));
  core.setOutput("target_dispatched", result.decision.targetDispatched);

  await core.summary.addRaw(result.summary).write();
}
