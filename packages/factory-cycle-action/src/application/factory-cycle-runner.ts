import * as core from "@actions/core";
import type { ExecClient } from "../../../action-common/src/exec-client.js";
import type { GitHubClient } from "../../../action-common/src/github-client.js";
import type { Issue } from "../../../action-common/src/types.js";

export class FactoryCycleRunner {
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
      "--auto",
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

export function findOpenSprint(issues: Issue[]): Issue | null {
  const sprints = issues.filter((issue) =>
    issue.labels.some((label: { name: string }) => label.name === "sprint"),
  );
  if (sprints.length === 0) return null;
  sprints.sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
  return sprints[0];
}
