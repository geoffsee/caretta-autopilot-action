import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ExecClient } from "./exec.js";
import { DefaultExecClient } from "./exec.js";
import type { GitHubClient } from "./github.js";
import { createOctokitClient } from "./github.js";
import {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "./install.js";
import {
  DEFAULT_AGENT_BRANCH,
  DEFAULT_CI_TIMEOUT_MINUTES,
  DEFAULT_TEST_CHECK_NAME,
  parseTimeoutMinutes,
  TrackerLoopRunner,
} from "./tracker-loop-runner.js";

export interface TrackerLoopMainDeps {
  readonly createGitHubClient: (
    token: string,
    owner: string,
    repo: string,
  ) => GitHubClient;
  readonly createExecClient: () => ExecClient;
  readonly installCaretta: typeof installCaretta;
  readonly installLinuxRuntimeDeps: typeof installLinuxRuntimeDeps;
  readonly materializeBotPrivateKey: typeof materializeBotPrivateKey;
}

export const defaultTrackerLoopMainDeps: TrackerLoopMainDeps = {
  createGitHubClient: createOctokitClient,
  createExecClient: () => new DefaultExecClient(),
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
};

export async function main(
  deps: TrackerLoopMainDeps = defaultTrackerLoopMainDeps,
): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const tracker = core.getInput("tracker", { required: true });
  const context = core.getInput("context") || "";
  const model = core.getInput("model") || "";
  const carettaVersion = core.getInput("caretta-version") || "latest";
  const agent = core.getInput("agent") || "claude";
  const testCheckName =
    core.getInput("test-check-name") || DEFAULT_TEST_CHECK_NAME;

  const agentBranchPatternInput =
    core.getInput("agent-branch-pattern") || DEFAULT_AGENT_BRANCH.source;
  const agentBranchPattern = new RegExp(agentBranchPatternInput);

  const ciTimeoutMinutes = parseTimeoutMinutes(
    core.getInput("ci-timeout-minutes") || String(DEFAULT_CI_TIMEOUT_MINUTES),
  );

  const { owner, repo } = github.context.repo;
  const gh = deps.createGitHubClient(token, owner, repo);
  const exec = deps.createExecClient();

  const { binaryPath, version } = await deps.installCaretta(
    carettaVersion,
    process.env.GITHUB_TOKEN || token,
  );
  await deps.installLinuxRuntimeDeps();

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  if (!env.GH_TOKEN) env.GH_TOKEN = token || process.env.GITHUB_TOKEN || "";
  if (!env.RUST_LOG) env.RUST_LOG = "info";
  if (context) env.CARETTA_CONTEXT = context;
  if (model) env.CARETTA_MODEL = model;
  deps.materializeBotPrivateKey(env);

  const runner = new TrackerLoopRunner(binaryPath, env, exec, gh, {
    tracker,
    agent,
    testCheckName,
    agentBranchPattern,
    ciTimeoutMs: ciTimeoutMinutes * 60 * 1000,
  });

  const result = await runner.runTrackerLoop();

  core.setOutput("tracker", tracker);
  core.setOutput("issue_count", String(result.issueCount));
  core.setOutput("reviewed_pr_count", String(result.reviewedPrCount));
  core.setOutput("caretta_version", version);
}
