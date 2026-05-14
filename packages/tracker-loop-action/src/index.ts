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

const DEFAULT_AGENT_BRANCH = /^agent\/issue-[0-9]+$/;
const DEFAULT_TEST_CHECK_NAME = "Test";
const DEFAULT_CI_TIMEOUT_MINUTES = 20;

interface TrackerLoopConfig {
  tracker: string;
  agent: string;
  testCheckName: string;
  agentBranchPattern: RegExp;
  ciTimeoutMs: number;
}

class TrackerLoopRunner {
  constructor(
    private readonly binaryPath: string,
    private readonly env: Record<string, string>,
    private readonly exec: ExecClient,
    private readonly gh: GitHubClient,
    private readonly config: TrackerLoopConfig,
  ) {}

  async runTrackerLoop(): Promise<{
    issueCount: number;
    reviewedPrCount: number;
  }> {
    core.info(`Starting tracker loop for #${this.config.tracker}`);

    const issues = await this.resolveTrackerIssues();

    for (const issue of issues) {
      await this.runCaretta("issue", [
        "--tracker",
        this.config.tracker,
        String(issue),
      ]);
    }

    await this.runCaretta("auto-merge", [
      "--tracker",
      this.config.tracker,
      "--sync-branches",
    ]);

    await this.fixConflicts();
    await this.runCiGate(issues);

    const prsForReview = await this.resolveTrackerScopedPrs(issues, true);
    for (const pr of prsForReview) {
      await this.runCaretta("code-review", [String(pr)]);
      await this.runCaretta("fix-pr", [String(pr)]);
    }

    await this.runCaretta("auto-merge", [
      "--tracker",
      this.config.tracker,
      "--sync-branches",
    ]);

    await this.fixConflicts();
    await this.runCiGate(issues);

    await this.runCaretta("auto-merge", [
      "--tracker",
      this.config.tracker,
      "--automerge-queue",
    ]);

    return { issueCount: issues.length, reviewedPrCount: prsForReview.length };
  }

  private async resolveTrackerIssues(): Promise<number[]> {
    const matrixOutput = await this.exec.getExecOutput(
      this.binaryPath,
      [
        "--agent",
        this.config.agent,
        "--preset",
        "software-factory",
        "tracker-matrix",
        this.config.tracker,
        "--json",
      ],
      { env: this.env, silent: true },
    );

    const raw = matrixOutput.stdout.trim() || "[]";
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("tracker-matrix output is not a JSON array");
      }
      const issues = parsed
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      core.info(`Found ${issues.length} tracker issues.`);
      return issues;
    } catch (error) {
      throw new Error(
        `Failed to parse tracker-matrix output: ${error instanceof Error ? error.message : String(error)}; raw=${raw}`,
      );
    }
  }

  private async runCaretta(task: string, args: string[] = []): Promise<void> {
    const fullArgs = [
      "--agent",
      this.config.agent,
      "--preset",
      "software-factory",
      task,
      ...args,
    ];
    core.info(`Running: ${this.binaryPath} ${fullArgs.join(" ")}`);
    await this.exec.exec(this.binaryPath, fullArgs, { env: this.env });
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
    const intervalMs = 30 * 1000;

    while (Date.now() - start < this.config.ciTimeoutMs) {
      const prs = await this.gh.listOpenPullRequests();
      const issueStrings = issues.map(String);
      const scopedPrs = prs.filter((pr) => {
        const match = pr.headRefName.match(/^agent\/issue-([0-9]+)$/);
        return match && issueStrings.includes(match[1]);
      });

      if (scopedPrs.length === 0) {
        core.info("No tracker-scoped PRs found for CI gate.");
        return;
      }

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
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    core.warning("Timed out waiting for CI completion.");
  }
}

function parseTimeoutMinutes(input: string): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CI_TIMEOUT_MINUTES;
  }
  return parsed;
}

async function run(): Promise<void> {
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

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
});
