import * as core from "@actions/core";
import type { ExecClient } from "./exec.js";
import type { GitHubClient } from "./github.js";
import {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "./install.js";
import type { AutopilotConfig, EvaluationResult } from "./types.js";

export interface ExecuteDeps {
  installCaretta: typeof installCaretta;
  installLinuxRuntimeDeps: typeof installLinuxRuntimeDeps;
  materializeBotPrivateKey: typeof materializeBotPrivateKey;
}

export const defaultExecuteDeps: ExecuteDeps = {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
};

export async function executeAutopilot(
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  evaluation: EvaluationResult,
  deps: ExecuteDeps = defaultExecuteDeps,
): Promise<void> {
  const { binaryPath } = await deps.installCaretta(
    config.carettaVersion,
    process.env.GITHUB_TOKEN || "",
  );
  await deps.installLinuxRuntimeDeps();

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  if (!env.GH_TOKEN) env.GH_TOKEN = process.env.GITHUB_TOKEN || "";
  if (!env.RUST_LOG) env.RUST_LOG = "info";
  if (config.context) env.CARETTA_CONTEXT = config.context;
  deps.materializeBotPrivateKey(env);

  const runner = new CarettaRunner(binaryPath, env, exec, gh, config);

  if (evaluation.workflow === config.trackerWorkflow) {
    await runner.runTrackerLoop(evaluation.tracker);
  } else if (evaluation.workflow === config.factoryWorkflow) {
    await runner.runFactoryCycle();
  } else {
    core.info(
      `No specific workflow logic to execute for ${evaluation.workflow}`,
    );
  }
}

class CarettaRunner {
  constructor(
    private readonly binaryPath: string,
    private readonly env: Record<string, string>,
    private readonly exec: ExecClient,
    private readonly gh: GitHubClient,
    private readonly config: AutopilotConfig,
  ) {}

  async runCaretta(task: string, args: string[] = []): Promise<number> {
    const fullArgs = [
      "--agent",
      this.config.agent,
      "--preset",
      "software-factory",
      task,
      ...args,
    ];
    core.info(`Running: ${this.binaryPath} ${fullArgs.join(" ")}`);
    return await this.exec.exec(this.binaryPath, fullArgs, { env: this.env });
  }

  async runTrackerLoop(tracker: string): Promise<void> {
    core.info(`Starting tracker loop for #${tracker}`);

    // 1. tracker-matrix
    const matrixOutput = await this.exec.getExecOutput(
      this.binaryPath,
      [
        "--agent",
        this.config.agent,
        "--preset",
        "software-factory",
        "tracker-matrix",
        tracker,
        "--json",
      ],
      { env: this.env, silent: true },
    );
    const issues: number[] = JSON.parse(matrixOutput.stdout.trim() || "[]");
    core.info(`Found ${issues.length} issues in tracker matrix.`);

    // 2. tracker-issue
    for (const issue of issues) {
      await this.runCaretta("issue", ["--tracker", tracker, String(issue)]);
    }

    // 3. sync-branches
    await this.runCaretta("auto-merge", [
      "--tracker",
      tracker,
      "--sync-branches",
    ]);

    // 4 & 5. fix-conflicts
    await this.fixConflicts();

    // 6. CI before review
    await this.runCiGate(issues);

    // 7, 8 & 9. Code Review and Fix PR
    const prsForReview = await this.resolveTrackerScopedPrs(issues, true);
    for (const pr of prsForReview) {
      await this.runCaretta("code-review", [String(pr)]);
      await this.runCaretta("fix-pr", [String(pr)]);
    }

    // 10. sync-branches (after fix)
    await this.runCaretta("auto-merge", [
      "--tracker",
      tracker,
      "--sync-branches",
    ]);

    // 11 & 12. fix-conflicts (after fix)
    await this.fixConflicts();

    // 13. CI after fix
    await this.runCiGate(issues);

    // 14. prepare-automerge
    await this.runCaretta("auto-merge", [
      "--tracker",
      tracker,
      "--automerge-queue",
    ]);
  }

  async runFactoryCycle(): Promise<void> {
    core.info("Starting factory cycle");

    // 1. housekeeping
    await this.runCaretta("housekeeping");

    // 2. preflight
    const openIssues = await this.gh.listOpenIssues();
    const hasOpenSprint = openIssues.some((i) =>
      i.labels.some((l) => l.name === "sprint"),
    );
    if (hasOpenSprint) {
      core.info("An open 'sprint' issue exists; skipping ideation cycle.");
      return;
    }

    // 3. ideation
    await this.runCaretta("run", ["ideation"]);

    // 4. report-research
    await this.runCaretta("run", ["report-research"]);

    // 5. strategic-review
    await this.runCaretta("run", ["strategic-review"]);

    // 6. sprint-planning
    await this.runCaretta("run", ["sprint-planning"]);
  }

  private async fixConflicts(): Promise<void> {
    const prs = await this.gh.listOpenPullRequests();
    const dirtyPrs = prs.filter(
      (pr) =>
        !pr.isDraft &&
        pr.mergeStateStatus === "DIRTY" &&
        this.config.agentBranchPattern.test(pr.headRefName),
    );

    for (const pr of dirtyPrs) {
      await this.runCaretta("fix-conflicts", [String(pr.number)]);
    }
  }

  private async resolveTrackerScopedPrs(
    issues: number[],
    requirePassingCi: boolean,
  ): Promise<number[]> {
    const prs = await this.gh.listOpenPullRequests();
    const issueStrings = issues.map(String);

    const candidates = prs.filter((pr) => {
      if (pr.isDraft || pr.mergeStateStatus === "DIRTY") return false;
      const match = pr.headRefName.match(/^agent\/issue-([0-9]+)$/);
      if (issueStrings.length > 0) {
        return match && issueStrings.includes(match[1]);
      }
      return !!match;
    });

    if (!requirePassingCi) {
      return candidates.map((pr) => pr.number);
    }

    const results: number[] = [];
    for (const pr of candidates) {
      const checks = await this.gh.listCheckRuns(pr.headRefOid);
      const testCheck = checks.find(
        (c) => c.name === this.config.testCheckName,
      );
      if (testCheck?.conclusion === "success") {
        results.push(pr.number);
      } else {
        core.info(
          `Skipping PR #${pr.number} because CI status is ${testCheck?.conclusion || "missing"}`,
        );
      }
    }
    return results;
  }

  private async runCiGate(issues: number[]): Promise<void> {
    core.info("Waiting for CI on tracker-scoped PRs...");
    const start = Date.now();
    const timeout = 20 * 60 * 1000; // 20 minutes timeout for this gate
    const interval = 30 * 1000; // 30 seconds interval

    while (Date.now() - start < timeout) {
      const prs = await this.gh.listOpenPullRequests();
      const issueStrings = issues.map(String);
      const scopedPrs = prs.filter((pr) => {
        const match = pr.headRefName.match(/^agent\/issue-([0-9]+)$/);
        return match && issueStrings.includes(match[1]);
      });

      if (scopedPrs.length === 0) break;

      let allDone = true;
      for (const pr of scopedPrs) {
        const checks = await this.gh.listCheckRuns(pr.headRefOid);
        const testCheck = checks.find(
          (c) => c.name === this.config.testCheckName,
        );
        if (
          !testCheck ||
          testCheck.status === "in_progress" ||
          testCheck.status === "queued"
        ) {
          allDone = false;
          break;
        }
      }

      if (allDone) {
        core.info("All CI runs completed.");
        return;
      }

      core.info("Waiting for CI to complete...");
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    core.warning("Timed out waiting for CI completion.");
  }
}
