import * as core from "@actions/core";
import {
  configureGitIdentity,
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "../../packages/action-common/src/caretta-install.js";
import { latestNamedCheck } from "../../packages/action-common/src/check-runs.js";
import type { ExecClient } from "../../packages/action-common/src/exec-client.js";
import type { GitHubClient } from "../../packages/action-common/src/github-client.js";
import type {
  AutopilotConfig,
  EvaluationResult,
  PullRequest,
} from "../../packages/action-common/src/types.js";
import { reconcileGateCommitStatus } from "./ci-dispatch-core.js";
import { dispatchMissingCi } from "./ci-dispatcher.js";
import {
  ConflictResolver,
  type ConflictResolverOptions,
} from "./conflict-resolver.js";

export interface ExecuteDeps {
  installCaretta: typeof installCaretta;
  installLinuxRuntimeDeps: typeof installLinuxRuntimeDeps;
  materializeBotPrivateKey: typeof materializeBotPrivateKey;
  configureGitIdentity: typeof configureGitIdentity;
  conflictResolverOptions?: ConflictResolverOptions;
  ciGateTimeoutMs?: number;
  ciGateIntervalMs?: number;
}

export const defaultExecuteDeps: ExecuteDeps = {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
  configureGitIdentity,
};

export async function setupCarettaRuntime(
  config: AutopilotConfig,
  deps: ExecuteDeps = defaultExecuteDeps,
): Promise<{ binaryPath: string; env: Record<string, string> }> {
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
  deps.materializeBotPrivateKey(env);
  if (!env.RUST_LOG) env.RUST_LOG = "info";
  if (config.context) env.CARETTA_CONTEXT = config.context;
  if (config.gitUserName && config.gitUserEmail) {
    env.GIT_AUTHOR_NAME = config.gitUserName;
    env.GIT_AUTHOR_EMAIL = config.gitUserEmail;
    env.GIT_COMMITTER_NAME = config.gitUserName;
    env.GIT_COMMITTER_EMAIL = config.gitUserEmail;
  }
  warnIfBotCredsIncomplete(env);
  await deps.configureGitIdentity(config.gitUserName, config.gitUserEmail);
  return { binaryPath, env };
}

/**
 * Decides whether an agent PR needs caretta to run `code-review` / `fix-pr`.
 * Shared by the `reviewAndFixAgentPRs` pre-pass and `CarettaRunner`'s
 * tracker-scoped review step so both stay in lockstep.
 *
 * Returns true when the latest `Test` check is completed AND either
 *   (a) `failure` (always needs another pass), or
 *   (b) `success` without a valid bot review on the current SHA.
 * Returns false when CI is in-flight/missing or a valid bot review already
 * covers the current SHA with passing CI.
 */
async function agentPrNeedsReviewOrFix(
  gh: GitHubClient,
  config: AutopilotConfig,
  pr: PullRequest,
): Promise<boolean> {
  const checks = await gh.listCheckRuns(pr.headRefOid);
  const latestCheck = latestNamedCheck(checks, config.testCheckName);
  if (!latestCheck || latestCheck.status !== "completed") return false;
  if (latestCheck.conclusion === "failure") return true;
  if (latestCheck.conclusion !== "success") return false;

  const reviews = await gh.listReviews(pr.number);
  const lastBotReview = reviews.filter((r) => r.user.includes("[bot]")).pop();
  const alreadyReviewed =
    !!lastBotReview &&
    lastBotReview.state !== "PENDING" &&
    lastBotReview.state !== "DISMISSED" &&
    lastBotReview.body.trim().length > 0 &&
    lastBotReview.commitId === pr.headRefOid;
  return !alreadyReviewed;
}

/**
 * Run `code-review` and `fix-pr` on agent PRs that need them, independently of
 * `decideExecution`'s hold gate. Without this, a PR with `Test=success` waiting
 * for review (or `Test=failure` needing remediation) is stuck whenever the hold
 * is engaged — either by another agent PR's active CI, or by `processAgentPRs`'s
 * own rerun of the failing PR's CI, which adds it to `prCi.dispatched` and
 * skips `executeAutopilot` → `runWorkDispatch` where review/fix lives.
 *
 * Returns true when caretta was invoked so the caller can re-fetch PR state to
 * pick up any new tips.
 */
export async function reviewAndFixAgentPRs(
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  prs: readonly PullRequest[],
  deps: ExecuteDeps = defaultExecuteDeps,
): Promise<boolean> {
  if (config.dryRun || !config.enableDispatch) return false;

  const candidates = prs.filter(
    (pr) =>
      !pr.isDraft &&
      pr.mergeStateStatus !== "DIRTY" &&
      config.agentBranchPattern.test(pr.headRefName),
  );
  if (candidates.length === 0) return false;

  const needsAction: PullRequest[] = [];
  for (const pr of candidates) {
    if (await agentPrNeedsReviewOrFix(gh, config, pr)) needsAction.push(pr);
  }
  if (needsAction.length === 0) return false;

  core.info(
    `reviewAndFixAgentPRs: ${needsAction.length} agent PR(s) need review/fix: ${needsAction
      .map((p) => `#${p.number}`)
      .join(", ")}`,
  );
  const { binaryPath, env } = await setupCarettaRuntime(config, deps);
  const runner = new CarettaRunner(binaryPath, env, exec, gh, config, deps);
  for (const pr of needsAction) {
    await runner.runCaretta("code-review", [String(pr.number)]);
    await runner.runCaretta("fix-pr", [String(pr.number)]);
  }
  return true;
}

/**
 * Resolve conflicts on any DIRTY agent PRs independently of the main execution
 * decision. Without this, a DIRTY PR cannot get `fix-conflicts` called whenever
 * another agent PR's CI is active — `decideExecution` holds the work route,
 * `executeAutopilot` is skipped, and the conflict resolver (which only runs
 * inside `runWorkDispatch`) never fires. Returns true when caretta was invoked
 * so the caller can re-fetch PR state to pick up the new tips.
 */
export async function resolveDirtyAgentPRs(
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  prs: readonly PullRequest[],
  deps: ExecuteDeps = defaultExecuteDeps,
): Promise<boolean> {
  if (config.dryRun || !config.enableDispatch) return false;

  const dirty = prs.filter(
    (pr) =>
      !pr.isDraft &&
      pr.mergeStateStatus === "DIRTY" &&
      config.agentBranchPattern.test(pr.headRefName),
  );
  if (dirty.length === 0) return false;

  core.info(
    `resolveDirtyAgentPRs: ${dirty.length} DIRTY agent PR(s) detected: ${dirty
      .map((p) => `#${p.number}`)
      .join(", ")}`,
  );
  const { binaryPath, env } = await setupCarettaRuntime(config, deps);

  const resolver = ConflictResolver.withCaretta(
    gh,
    config,
    binaryPath,
    env,
    exec,
    deps.conflictResolverOptions ?? {},
  );
  const result = await resolver.resolveAll();
  if (result.unresolved.length > 0) {
    core.warning(
      `resolveDirtyAgentPRs left ${result.unresolved.length} PR(s) DIRTY after retries: ${result.unresolved.join(", ")}${result.timedOut ? " (timed out)" : ""}`,
    );
  }
  return true;
}

export async function executeAutopilot(
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  evaluation: EvaluationResult,
  deps: ExecuteDeps = defaultExecuteDeps,
): Promise<void> {
  const { binaryPath, env } = await setupCarettaRuntime(config, deps);

  const runner = new CarettaRunner(binaryPath, env, exec, gh, config, deps);

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

export function warnIfBotCredsIncomplete(env: Record<string, string>): void {
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
    private readonly deps: ExecuteDeps,
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
    await dispatchMissingCi(this.gh, this.config);

    // 6. CI before review
    await this.runCiGate(issues);

    // 7, 8 & 9. Code Review and Fix PR
    const prsForReview = await this.resolveTrackerScopedPrs(issues, true);
    for (const pr of prsForReview) {
      await this.runCaretta("code-review", [String(pr)]);
      await this.runCaretta("fix-pr", [String(pr)]);
    }

    if (prsForReview.length > 0) {
      // 10. sync-branches (after fix)
      await this.runCaretta("auto-merge", [
        "--tracker",
        tracker,
        "--sync-branches",
      ]);

      // 11 & 12. fix-conflicts (after fix)
      await this.fixConflicts();
      await dispatchMissingCi(this.gh, this.config);

      // 13. CI after fix
      await this.runCiGate(issues);
    }

    const prsAfterFix = await this.gh.listOpenPullRequests();
    const issueStringsAfterFix = issues.map(String);
    const queuedPrs = prsAfterFix.filter((pr) => {
      const match = pr.headRefName.match(/^agent\/issue-([0-9]+)(?:-.*)?$/);
      return match && issueStringsAfterFix.includes(match[1]);
    });

    const needsAutomerge = queuedPrs.some((pr) => !pr.isAutoMergeEnabled);

    if (needsAutomerge) {
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
      await dispatchMissingCi(this.gh, this.config);
    } else {
      core.info(
        "All tracker-scoped PRs already have auto-merge enabled. Skipping automerge-queue.",
      );
    }
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
      this.deps.conflictResolverOptions ?? {},
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
      const match = pr.headRefName.match(/^agent\/issue-([0-9]+)(?:-.*)?$/);
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
      if (await agentPrNeedsReviewOrFix(this.gh, this.config, pr)) {
        results.push(pr.number);
      } else {
        core.info(
          `Skipping PR #${pr.number}: already reviewed for ${pr.headRefOid} or CI not actionable`,
        );
      }
    }
    return results;
  }

  private async runCiGate(_issues: number[]): Promise<void> {
    core.info("Waiting for CI on tracker-scoped PRs...");
    const start = Date.now();
    const timeout = this.deps.ciGateTimeoutMs ?? 20 * 60 * 1000; // 20 minutes timeout for this gate
    const interval = this.deps.ciGateIntervalMs ?? 30 * 1000; // 30 seconds interval

    while (Date.now() - start < timeout) {
      const prs = await this.gh.listOpenPullRequests();
      const scopedPrs = prs.filter((pr) => {
        const match = pr.headRefName.match(/^agent\/issue-([0-9]+)(?:-.*)?$/);
        // We wait for all agent-branch PRs related to this tracker.
        // If auto-merge synced it, we should wait for it.
        return !!match;
      });

      if (scopedPrs.length === 0) {
        core.info("No tracker-scoped PRs to wait on; skipping CI gate.");
        return;
      }

      let allDone = true;
      for (const pr of scopedPrs) {
        const checks = await this.gh.listCheckRuns(pr.headRefOid);

        // Find if we have an authoritative background workflow run for this SHA
        const allRuns = await this.gh.listWorkflowRuns(
          this.config.ciWorkflow,
          undefined,
          pr.headRefName,
        );
        const latestShaRun = allRuns
          .filter((r) => r.headSha === pr.headRefOid)
          .sort((a, b) => b.id - a.id)[0];

        const latestCheck = latestNamedCheck(checks, this.config.testCheckName);

        // If the background run is completed, we can use its conclusion to "fix" any stuck statuses
        if (latestShaRun && latestShaRun.status === "completed") {
          const conclusion =
            latestShaRun.conclusion === "success" ? "success" : "failure";

          // If the latest check is not completed, or we have no check yet, synchronize.
          // The write is idempotent: skip if the commit status already matches
          // so polling doesn't keep re-writing while the check_run lags behind.
          if (!latestCheck || latestCheck.status !== "completed") {
            const currentStatus = await this.gh.getLatestCommitStatus(
              pr.headRefOid,
              this.config.testCheckName,
            );
            if (currentStatus !== conclusion) {
              core.info(
                `runCiGate: Background run ${latestShaRun.id} is completed (${latestShaRun.conclusion}); updating PR status for PR #${pr.number}.`,
              );
              await this.gh.createCommitStatus(
                pr.headRefOid,
                conclusion,
                this.config.testCheckName,
                `Autopilot synchronized from run ${latestShaRun.id}`,
              );
            }
            // This will be picked up in the next iteration
            allDone = false;
            continue;
          }
        }

        if (!latestCheck) {
          core.info(
            `runCiGate: PR #${pr.number} (${pr.headRefName}) at SHA ${pr.headRefOid} has no "${this.config.testCheckName}" check run yet.`,
          );
          allDone = false;
          break;
        }

        if (
          latestCheck.status === "in_progress" ||
          latestCheck.status === "queued"
        ) {
          core.info(
            `runCiGate: PR #${pr.number} (${pr.headRefName}) at SHA ${pr.headRefOid} latest "${this.config.testCheckName}" check is active (${latestCheck.status}).`,
          );
          allDone = false;
          break;
        }

        core.info(
          `runCiGate: PR #${pr.number} (${pr.headRefName}) at SHA ${pr.headRefOid} latest "${this.config.testCheckName}" check is ${latestCheck.status} (${latestCheck.conclusion}).`,
        );
        await reconcileGateCommitStatus(
          this.gh,
          this.config,
          pr,
          latestCheck,
          "runCiGate",
        );
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
