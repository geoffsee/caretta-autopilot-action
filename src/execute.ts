import * as core from "@actions/core";
import { dispatchMissingCi } from "./ci-dispatcher.js";
import {
  ConflictResolver,
  type ConflictResolverOptions,
} from "./conflict-resolver.js";
import type { ExecClient } from "./exec.js";
import type { GitHubClient } from "./github.js";
import {
  configureGitIdentity,
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "./install.js";
import type { AutopilotConfig, EvaluationResult } from "./types.js";

export interface ExecuteDeps {
  installCaretta: typeof installCaretta;
  installLinuxRuntimeDeps: typeof installLinuxRuntimeDeps;
  materializeBotPrivateKey: typeof materializeBotPrivateKey;
  configureGitIdentity: typeof configureGitIdentity;
  conflictResolverOptions?: ConflictResolverOptions;
}

export const defaultExecuteDeps: ExecuteDeps = {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
  configureGitIdentity,
};

export async function executeAutopilot(
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  evaluation: EvaluationResult,
  deps: ExecuteDeps = defaultExecuteDeps,
): Promise<void> {
  const installToken =
    config.githubToken?.trim() || process.env.GITHUB_TOKEN || "";
  const { binaryPath } = await deps.installCaretta(
    config.carettaVersion,
    installToken,
  );
  await deps.installLinuxRuntimeDeps();

  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  const authToken =
    config.githubToken?.trim() ||
    env.GH_TOKEN?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    "";
  if (authToken) {
    env.GH_TOKEN = authToken;
    env.GITHUB_TOKEN = authToken;
  }
  if (!env.RUST_LOG) env.RUST_LOG = "info";
  if (config.context) env.CARETTA_CONTEXT = config.context;
  if (config.gitUserName && config.gitUserEmail) {
    env.GIT_AUTHOR_NAME = config.gitUserName;
    env.GIT_AUTHOR_EMAIL = config.gitUserEmail;
    env.GIT_COMMITTER_NAME = config.gitUserName;
    env.GIT_COMMITTER_EMAIL = config.gitUserEmail;
  }
  deps.materializeBotPrivateKey(env);
  warnIfBotCredsIncomplete(env);
  await deps.configureGitIdentity(config.gitUserName, config.gitUserEmail);

  const runner = new CarettaRunner(
    binaryPath,
    env,
    exec,
    gh,
    config,
    deps.conflictResolverOptions,
  );

  switch (evaluation.route) {
    case "work":
      await runner.runWorkDispatch(evaluation.tracker);
      break;
    case "factory":
      await runner.runFactoryCycle();
      break;
    default:
      core.info(`No logic to execute for route '${evaluation.route}'`);
  }
}

function warnIfBotCredsIncomplete(env: Record<string, string>): void {
  const hasTokenCreds =
    !!env.DEV_BOT_TOKEN?.trim() || !!env.DEV_BOT_TOKEN_PATH?.trim();
  if (hasTokenCreds) return;

  const hasAppId = !!env.DEV_BOT_APP_ID?.trim();
  const hasPrivateKey = !!env.DEV_BOT_PRIVATE_KEY?.trim();
  const hasInstallationId = !!env.DEV_BOT_INSTALLATION_ID?.trim();

  if (hasAppId && hasPrivateKey && !hasInstallationId) {
    core.warning(
      "DEV_BOT_APP_ID and DEV_BOT_PRIVATE_KEY are set but DEV_BOT_INSTALLATION_ID is missing. " +
        "caretta will fall back to GITHUB_TOKEN, which cannot post pull-request reviews (expect HTTP 403 on code-review).",
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
    private readonly conflictResolverOptions: ConflictResolverOptions = {},
  ) {}

  /** Headless CI runs need `--auto`: two-phase workflows synthesize feedback and run finalize. */
  private carettaBaseArgs(): string[] {
    return ["--auto", "--agent", this.config.agent];
  }

  async runCaretta(task: string, args: string[] = []): Promise<number> {
    const fullArgs = [...this.carettaBaseArgs(), task, ...args];
    core.info(`Running: ${this.binaryPath} ${fullArgs.join(" ")}`);
    return await this.exec.exec(this.binaryPath, fullArgs, { env: this.env });
  }

  async runWorkDispatch(tracker: string): Promise<void> {
    core.info(`Starting work dispatch for #${tracker}`);

    // 1. tracker-matrix
    const matrixOutput = await this.exec.getExecOutput(
      this.binaryPath,
      [...this.carettaBaseArgs(), "tracker-matrix", tracker, "--json"],
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
    await dispatchMissingCi(this.gh, this.config, { issueNumbers: issues });

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
    await dispatchMissingCi(this.gh, this.config, { issueNumbers: issues });

    // 13. CI after fix
    await this.runCiGate(issues);

    // 14. prepare-automerge
    await this.runCaretta("auto-merge", [
      "--tracker",
      tracker,
      "--automerge-queue",
    ]);

    // 15. dispatch CI on tips that automerge-queue advanced.
    // `auto-merge --automerge-queue` calls `gh pr update-branch` for each PR,
    // which fast-forwards the branch tip to a new SHA when main has moved.
    // The Test check from step 13 is attached to the prior SHA, so the new tip
    // has no Test check — auto-merge then sits waiting on a check that nothing
    // will dispatch. Fire one more dispatch so the queue can drain.
    await dispatchMissingCi(this.gh, this.config, { issueNumbers: issues });
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
    const resolver = ConflictResolver.withCaretta(
      this.gh,
      this.config,
      this.binaryPath,
      this.env,
      this.exec,
      this.conflictResolverOptions,
    );
    const result = await resolver.resolveAll();
    if (result.unresolved.length > 0) {
      core.warning(
        `ConflictResolver left ${result.unresolved.length} PR(s) DIRTY after retries: ${result.unresolved.join(", ")}${result.timedOut ? " (timed out)" : ""}`,
      );
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

      if (scopedPrs.length === 0) {
        core.info("No tracker-scoped PRs to wait on; skipping CI gate.");
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
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    core.warning("Timed out waiting for CI completion.");
  }
}
