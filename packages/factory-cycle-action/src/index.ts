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
import type { Issue } from "./types.js";

class FactoryCycleRunner {
  constructor(
    private readonly binaryPath: string,
    private readonly env: Record<string, string>,
    private readonly exec: ExecClient,
    private readonly gh: GitHubClient,
    private readonly agent: string,
  ) {}

  async runFactoryCycle(): Promise<{ skipped: boolean; activeSprint: string }> {
    core.info("Starting factory cycle");

    await this.runCaretta("housekeeping");

    const openIssues = await this.gh.listOpenIssues();
    const sprint = findOpenSprint(openIssues);
    if (sprint) {
      core.info(
        `Open sprint #${sprint.number} exists; skipping ideation cycle.`,
      );
      return { skipped: true, activeSprint: String(sprint.number) };
    }

    await this.runCaretta("run", ["ideation"]);
    await this.runCaretta("run", ["report-research"]);
    await this.runCaretta("run", ["strategic-review"]);
    await this.runCaretta("run", ["sprint-planning"]);

    return { skipped: false, activeSprint: "" };
  }

  private async runCaretta(task: string, args: string[] = []): Promise<void> {
    const fullArgs = [
      "--agent",
      this.agent,
      "--preset",
      "software-factory",
      task,
      ...args,
    ];
    core.info(`Running: ${this.binaryPath} ${fullArgs.join(" ")}`);
    await this.exec.exec(this.binaryPath, fullArgs, { env: this.env });
  }
}

function findOpenSprint(issues: Issue[]): Issue | null {
  const sprints = issues.filter((issue) =>
    issue.labels.some((label: { name: string }) => label.name === "sprint"),
  );
  if (sprints.length === 0) return null;
  sprints.sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
  return sprints[0];
}

async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const context = core.getInput("context") || "";
  const model = core.getInput("model") || "";
  const carettaVersion = core.getInput("caretta-version") || "latest";
  const agent = core.getInput("agent") || "claude";

  const { owner, repo } = github.context.repo;
  const gh = createOctokitClient(token, owner, repo);
  const exec = new DefaultExecClient();

  const { binaryPath, version } = await installCaretta(
    carettaVersion,
    process.env.GITHUB_TOKEN || token,
  );
  await installLinuxRuntimeDeps();

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  if (!env.GH_TOKEN) env.GH_TOKEN = token || process.env.GITHUB_TOKEN || "";
  if (!env.RUST_LOG) env.RUST_LOG = "info";
  if (context) env.CARETTA_CONTEXT = context;
  if (model) env.CARETTA_MODEL = model;
  materializeBotPrivateKey(env);

  const runner = new FactoryCycleRunner(binaryPath, env, exec, gh, agent);
  const result = await runner.runFactoryCycle();

  core.setOutput("skipped_due_to_open_sprint", String(result.skipped));
  core.setOutput("active_sprint", result.activeSprint);
  core.setOutput("caretta_version", version);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
});
