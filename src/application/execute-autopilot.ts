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
  MergedPullRequest,
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
 * `code-review` and `fix-pr` are independent — each has its own preconditions
 * and is dispatched on its own merits.
 *
 * Running the pair back-to-back on the same SHA is what produced the
 * approval-invalidation loop on geoffsee/autopilot-example-project PR #189:
 * `code-review` posted APPROVED, then `fix-pr` pushed a follow-up commit for
 * a nit thread, dismissing the approval under
 * `require_last_push_approval=true`. Evaluating each predicate separately —
 * and never reviewing failing code, never fixing what has no remediation
 * signal — breaks that loop.
 */

/**
 * code-review gates merging with a fresh bot review. It runs only when CI is
 * green at the head SHA and no valid bot review already covers that SHA.
 * Reviewing failing code is pointless (and producing an APPROVED review on
 * broken code is actively harmful).
 */
async function shouldRunCodeReview(
  gh: GitHubClient,
  config: AutopilotConfig,
  pr: PullRequest,
): Promise<boolean> {
  const checks = await gh.listCheckRuns(pr.headRefOid);
  const latestCheck = latestNamedCheck(checks, config.testCheckName);
  if (!latestCheck || latestCheck.status !== "completed") return false;
  if (latestCheck.conclusion !== "success") return false;

  const reviews = await gh.listReviews(pr.number);
  const lastBotReview = reviews
    .filter(
      (r) =>
        r.user.includes("[bot]") &&
        r.state !== "PENDING" &&
        r.state !== "DISMISSED" &&
        r.body.trim().length > 0,
    )
    .pop();
  return !lastBotReview || lastBotReview.commitId !== pr.headRefOid;
}

/**
 * fix-pr remediates failure signals: a red Test check, or a CHANGES_REQUESTED
 * review at the head SHA. Without a remediation signal there's nothing for
 * fix-pr to fix — running it would push a no-op commit and (worst case)
 * dismiss a fresh approval.
 */
async function shouldRunFixPr(
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
  const lastBotReview = reviews
    .filter(
      (r) =>
        r.user.includes("[bot]") &&
        r.state !== "PENDING" &&
        r.state !== "DISMISSED" &&
        r.body.trim().length > 0,
    )
    .pop();
  return (
    !!lastBotReview &&
    lastBotReview.commitId === pr.headRefOid &&
    lastBotReview.state === "CHANGES_REQUESTED"
  );
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

  const plan: Array<{
    pr: PullRequest;
    fix: boolean;
    review: boolean;
  }> = [];
  for (const pr of candidates) {
    const fix = await shouldRunFixPr(gh, config, pr);
    const review = await shouldRunCodeReview(gh, config, pr);
    if (fix || review) plan.push({ pr, fix, review });
  }
  if (plan.length === 0) return false;

  core.info(
    `reviewAndFixAgentPRs: ${plan.length} agent PR(s) need action: ${plan
      .map(
        ({ pr, fix, review }) =>
          `#${pr.number}[${[fix && "fix-pr", review && "code-review"].filter(Boolean).join("+") || "none"}]`,
      )
      .join(", ")}`,
  );
  const { binaryPath, env } = await setupCarettaRuntime(config, deps);
  const runner = new CarettaRunner(binaryPath, env, exec, gh, config, deps);
  for (const { pr, fix, review } of plan) {
    // fix-pr first: it's the only step that pushes, so any subsequent
    // code-review will land on the freshly-pushed SHA — no approval-then-push
    // ordering that branch protection would dismiss.
    if (fix) await runner.runCaretta("fix-pr", [String(pr.number)]);
    if (review) await runner.runCaretta("code-review", [String(pr.number)]);
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

    // 7, 8 & 9. fix-pr and code-review — evaluated independently per PR.
    // `shouldRunFixPr` and `shouldRunCodeReview` each have their own
    // preconditions (see their docstrings); the action runs whichever apply.
    // fix-pr always runs first so any subsequent review lands on the
    // freshly-pushed SHA.
    const prActions = await this.resolveTrackerScopedPrs(issues, true);
    for (const { number, fix, review } of prActions) {
      if (fix) await this.runCaretta("fix-pr", [String(number)]);
      if (review) await this.runCaretta("code-review", [String(number)]);
    }

    if (prActions.length > 0) {
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
    // When `tracker-matrix` returns no pending issues (sprint finished, or an
    // upstream parser regression like the 2026-05-21 wedge), fall back to
    // "all open agent PRs" so auto-merge still gets enabled on merge-ready
    // PRs. Mirrors the same fallback shape as `resolveTrackerScopedPrs`.
    const queuedPrs = prsAfterFix.filter((pr) => {
      const match = pr.headRefName.match(/^agent\/issue-([0-9]+)(?:-.*)?$/);
      if (!match) return false;
      if (issueStringsAfterFix.length === 0) return true;
      return issueStringsAfterFix.includes(match[1]);
    });

    const needsAutomerge = queuedPrs.some((pr) => !pr.isAutoMergeEnabled);

    if (needsAutomerge) {
      // 14a. Enable auto-merge directly via the GitHub API for each merge-ready
      // PR that lacks it. Caretta's `--automerge-queue` (called below) is the
      // legacy path and does additional useful work (per-PR `update-branch`,
      // base retargeting), but its lineage resolution shares the same parser
      // path as `tracker-matrix` and silently bails with "nothing scheduled"
      // when the parser leaks `(blocked by #X)` into the completed set —
      // exactly the wedge observed on 2026-05-21 (post-mortem:
      // .dev/docs/post-mortems/2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md).
      // Enabling here, before calling caretta, makes the autopilot resilient
      // to that class of empty-lineage failure regardless of root cause.
      //
      // Stacked agent PRs: hold any parent branch that still has a queued open
      // child (merge deepest leaf against its stacked base first). When base ≠
      // default, resolve parents via open vs recently-merged refs before merge.
      const defaultBranch = await this.gh.getDefaultBranch();
      const mergedSnapshot = await this.gh.listRecentlyMergedPullRequests();
      const blockedParentNumbers = new Set<number>();
      for (const child of queuedPrs) {
        const parentPr = queuedPrs.find(
          (p) => p.headRefName === child.baseRefName,
        );
        if (parentPr) blockedParentNumbers.add(parentPr.number);
      }
      const openPrsSnapshot = prsAfterFix;
      for (const pr of queuedPrs) {
        if (pr.isAutoMergeEnabled) continue;

        if (blockedParentNumbers.has(pr.number)) {
          const child = queuedPrs.find((c) => c.baseRefName === pr.headRefName);
          if (child) {
            core.info(
              `Holding auto-merge on parent PR #${pr.number} this tick: child PR #${child.number} (base=${child.baseRefName}) must merge first to preserve stack.`,
            );
          }
          continue;
        }

        let justRebased = false;
        if (pr.baseRefName !== defaultBranch) {
          const openParent = openPrsSnapshot.find(
            (p) => p.headRefName === pr.baseRefName,
          );
          if (!openParent) {
            const stackedParentMerged = mergedSnapshot.some(
              (m) =>
                m.headRefName === pr.baseRefName &&
                m.baseRefName === defaultBranch,
            );
            if (!stackedParentMerged) {
              core.warning(
                `Stacked PR #${pr.number} has base '${pr.baseRefName}' with no matching open pull request head and no merged PR that shipped that ref from '${defaultBranch}' (orphan stack state); skipping.`,
              );
              continue;
            }
            const rebased = await this.tryRebaseStackedPrToDefault(
              pr,
              defaultBranch,
              mergedSnapshot,
            );
            if (!rebased) {
              continue;
            }
            justRebased = true;
          }
          // Else: stacked base resolves to an open parent head → merge/auto into that base below.
        }

        if (this.config.dryRun) {
          core.info(
            `Skipping merge/auto-merge enable for PR #${pr.number} (dryRun).`,
          );
          continue;
        }

        // If the PR is already in CLEAN merge state, `enablePullRequestAutoMerge`
        // rejects with "Pull request is in clean status" because GitHub has
        // nothing left to wait on. Merge directly in that case. See post-mortem
        // .dev/docs/post-mortems/2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md
        // § "Manual unstick of PR #159".
        //
        // Skip the fast-path when we just rebased — the in-memory
        // mergeStateStatus and headRefOid are pre-rebase reads and would feed
        // a stale `sha` precondition to `pulls.merge`. The next tick picks up
        // the freshly-rebased PR with accurate state.
        if (!justRebased && pr.mergeStateStatus === "CLEAN") {
          try {
            await this.gh.mergePullRequest(pr.number, "SQUASH", pr.headRefOid);
            core.info(
              `Merged PR #${pr.number} directly (mergeStateStatus=CLEAN; auto-merge has nothing to wait on).`,
            );
          } catch (err) {
            core.warning(
              `Failed to merge PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          continue;
        }
        try {
          await this.gh.enableAutoMerge(pr.number);
          core.info(`Enabled auto-merge on PR #${pr.number}.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Belt-and-suspenders: if the PR's mergeStateStatus stale-read missed
          // the CLEAN transition between `listOpenPullRequests` and the mutation
          // firing, fall back to a direct merge.
          if (/clean status/i.test(msg)) {
            try {
              await this.gh.mergePullRequest(
                pr.number,
                "SQUASH",
                pr.headRefOid,
              );
              core.info(
                `Merged PR #${pr.number} directly after enableAutoMerge reported clean status.`,
              );
              continue;
            } catch (mergeErr) {
              core.warning(
                `Failed to merge PR #${pr.number} after enableAutoMerge clean-status fallback: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`,
              );
              continue;
            }
          }
          core.warning(
            `Failed to enable auto-merge on PR #${pr.number}: ${msg}`,
          );
        }
      }

      // 14b. prepare-automerge (caretta path — still useful for branch updates
      // and base retargeting on stacked PRs when the lineage resolves).
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

  /**
   * Rebase a stacked agent PR's head onto the default branch and retarget the
   * PR. Eligible only when the PR's current base ref matches a recently merged
   * PR's head ref against the default branch — i.e., the parent has actually
   * shipped to main. Without that guard we would orphan work off a still-open
   * parent. See post-mortem
   * 2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md
   * action item "Code, stacked-PR special case".
   */
  private async tryRebaseStackedPrToDefault(
    pr: PullRequest,
    defaultBranch: string,
    mergedCandidates?: readonly MergedPullRequest[],
  ): Promise<boolean> {
    if (this.config.dryRun) return false;
    if (!this.config.agentBranchPattern.test(pr.headRefName)) return false;
    if (pr.mergeStateStatus === "DIRTY") return false;

    const mergedPrs =
      mergedCandidates ?? (await this.gh.listRecentlyMergedPullRequests());
    const parent = mergedPrs.find(
      (m) =>
        m.headRefName === pr.baseRefName && m.baseRefName === defaultBranch,
    );
    if (!parent) return false;

    core.info(
      `Auto-rebase: PR #${pr.number} base '${pr.baseRefName}' was merged into '${defaultBranch}' via PR #${parent.number}; rebasing head onto '${defaultBranch}' and retargeting.`,
    );

    const gitOpts = { env: this.env, ignoreReturnCode: true };

    const fetchCode = await this.exec.exec(
      "git",
      ["fetch", "origin", defaultBranch, pr.headRefName],
      gitOpts,
    );
    if (fetchCode !== 0) {
      core.warning(
        `Auto-rebase: git fetch failed for PR #${pr.number} (exit ${fetchCode}); skipping.`,
      );
      return false;
    }

    const switchCode = await this.exec.exec(
      "git",
      ["switch", pr.headRefName],
      gitOpts,
    );
    if (switchCode !== 0) {
      core.warning(
        `Auto-rebase: git switch ${pr.headRefName} failed for PR #${pr.number} (exit ${switchCode}); skipping.`,
      );
      return false;
    }

    const baseRemoteRef = `origin/${pr.baseRefName}`;
    const baseRefExistsCode = await this.exec.exec(
      "git",
      ["rev-parse", "--verify", baseRemoteRef],
      gitOpts,
    );
    const rebaseArgs =
      baseRefExistsCode === 0
        ? ["rebase", "--onto", `origin/${defaultBranch}`, baseRemoteRef]
        : ["rebase", `origin/${defaultBranch}`];
    if (baseRefExistsCode !== 0) {
      core.warning(
        `Auto-rebase: ${baseRemoteRef} missing for PR #${pr.number}; falling back to full rebase onto origin/${defaultBranch}.`,
      );
    }

    const rebaseCode = await this.exec.exec("git", rebaseArgs, gitOpts);
    if (rebaseCode !== 0) {
      await this.exec.exec("git", ["rebase", "--abort"], gitOpts);
      core.warning(
        `Auto-rebase: rebase onto origin/${defaultBranch} failed for PR #${pr.number} (likely conflicts); aborted.`,
      );
      try {
        await this.gh.retargetPullRequest(pr.number, defaultBranch);
        core.warning(
          `Auto-rebase: fallback retargeted PR #${pr.number} to '${defaultBranch}' after rebase conflict; automated conflict handling will continue on subsequent ticks.`,
        );
      } catch (err) {
        core.warning(
          `Auto-rebase: fallback retarget failed for PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return false;
    }

    const pushCode = await this.exec.exec(
      "git",
      ["push", "--force-with-lease", "origin", pr.headRefName],
      gitOpts,
    );
    if (pushCode !== 0) {
      core.warning(
        `Auto-rebase: force-push failed for PR #${pr.number} (exit ${pushCode}); skipping retarget.`,
      );
      return false;
    }

    try {
      await this.gh.retargetPullRequest(pr.number, defaultBranch);
    } catch (err) {
      core.warning(
        `Auto-rebase: retarget failed for PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }

    core.info(
      `Auto-rebase: PR #${pr.number} rebased onto '${defaultBranch}' and retargeted.`,
    );
    return true;
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
  ): Promise<Array<{ number: number; fix: boolean; review: boolean }>> {
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
      return candidates.map((pr) => ({
        number: pr.number,
        fix: false,
        review: true,
      }));
    }

    const results: Array<{ number: number; fix: boolean; review: boolean }> =
      [];
    for (const pr of candidates) {
      const fix = await shouldRunFixPr(this.gh, this.config, pr);
      const review = await shouldRunCodeReview(this.gh, this.config, pr);
      if (!fix && !review) {
        core.info(
          `Skipping PR #${pr.number}: nothing to do at ${pr.headRefOid} (CI in flight or review already settled)`,
        );
        continue;
      }
      results.push({ number: pr.number, fix, review });
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
