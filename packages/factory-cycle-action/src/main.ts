import * as core from "@actions/core";
import * as github from "@actions/github";
import type { ExecClient } from "./exec.js";
import { DefaultExecClient } from "./exec.js";
import { FactoryCycleRunner } from "./factory-cycle-runner.js";
import type { GitHubClient } from "./github.js";
import { createOctokitClient } from "./github.js";
import {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "./install.js";

export interface FactoryCycleMainDeps {
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

export const defaultFactoryCycleMainDeps: FactoryCycleMainDeps = {
  createGitHubClient: createOctokitClient,
  createExecClient: () => new DefaultExecClient(),
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
};

export async function main(
  deps: FactoryCycleMainDeps = defaultFactoryCycleMainDeps,
): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const context = core.getInput("context") || "";
  const model = core.getInput("model") || "";
  const carettaVersion = core.getInput("caretta-version") || "latest";
  const agent = core.getInput("agent") || "claude";

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

  const runner = new FactoryCycleRunner(binaryPath, env, exec, gh, agent);
  const result = await runner.runFactoryCycle();

  core.setOutput("skipped_due_to_open_sprint", String(result.skipped));
  core.setOutput("active_sprint", result.activeSprint);
  core.setOutput("caretta_version", version);
}
