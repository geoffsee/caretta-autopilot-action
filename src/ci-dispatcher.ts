import * as core from "@actions/core";
import type { GitHubClient } from "./github.js";
import type { AutopilotConfig } from "./types.js";

export interface DispatchMissingCiOptions {
  /** When set, restricts to PRs whose branch matches `agent/issue-<n>` for one of these issue numbers. */
  readonly issueNumbers?: readonly number[];
}

export interface DispatchMissingCiResult {
  readonly dispatched: readonly number[];
  readonly skipped: readonly number[];
  readonly failed: readonly number[];
}

/**
 * After fix-conflicts pushes a new commit, the PR's head SHA has no Test
 * check and `runCiGate` cannot distinguish that from a queued check — it
 * hangs. This helper dispatches `ciWorkflow` for any agent PR whose current
 * head lacks a Test check and has no queued/in_progress run at that SHA.
 */
export async function dispatchMissingCi(
  gh: GitHubClient,
  config: AutopilotConfig,
  options: DispatchMissingCiOptions = {},
): Promise<DispatchMissingCiResult> {
  if (config.dryRun || !config.enableDispatch) {
    core.info(`dispatchMissingCi: skipping (dryRun=${config.dryRun}, enableDispatch=${config.enableDispatch})`);
    return { dispatched: [], skipped: [], failed: [] };
  }

  const scope = options.issueNumbers
    ? new Set(options.issueNumbers.map(String))
    : undefined;

  const prs = await gh.listOpenPullRequests();
  core.info(`dispatchMissingCi: found ${prs.length} total open PRs`);

  const eligible = prs.filter((pr) => {
    if (pr.isDraft) return false;
    if (!config.agentBranchPattern.test(pr.headRefName)) return false;
    return true;
  });
  core.info(`dispatchMissingCi: ${eligible.length} PRs match agent branch pattern`);

  const dispatched: number[] = [];
  const skipped: number[] = [];
  const failed: number[] = [];

  for (const pr of eligible) {
    const m = pr.headRefName.match(/^agent\/issue-([0-9]+)$/);
    const issueNum = m ? m[1] : undefined;

    if (scope && (!issueNum || !scope.has(issueNum))) {
      core.info(`dispatchMissingCi: skipping PR #${pr.number} (${pr.headRefName}) - not in current issue scope`);
      continue;
    }

    const checks = await gh.listCheckRuns(pr.headRefOid);
    const testChecks = checks.filter((c) => c.name === config.testCheckName);
    
    if (testChecks.length > 0) {
      const latestCheck = testChecks.sort((a, b) => {
        const aTime = new Date(a.createdAt || a.startedAt || 0).getTime();
        const bTime = new Date(b.createdAt || b.startedAt || 0).getTime();
        return bTime - aTime;
      })[0];
      
      core.info(`dispatchMissingCi: PR #${pr.number} already has ${testChecks.length} check(s) named "${config.testCheckName}". Latest status: ${latestCheck.status}, conclusion: ${latestCheck.conclusion}`);
      skipped.push(pr.number);
      continue;
    }

    const [queued, inProgress] = await Promise.all([
      gh.listWorkflowRuns(config.ciWorkflow, "queued", pr.headRefName),
      gh.listWorkflowRuns(config.ciWorkflow, "in_progress", pr.headRefName),
    ]);
    const activeForSha = [
      ...queued.filter((r) => r.headSha === pr.headRefOid),
      ...inProgress.filter((r) => r.headSha === pr.headRefOid),
    ];

    if (activeForSha.length > 0) {
      core.info(`dispatchMissingCi: PR #${pr.number} has ${activeForSha.length} active workflow run(s) for SHA ${pr.headRefOid}`);
      skipped.push(pr.number);
      continue;
    }

    try {
      core.info(`dispatchMissingCi: dispatching ${config.ciWorkflow} for PR #${pr.number} (${pr.headRefName}) at SHA ${pr.headRefOid}`);
      await gh.dispatchWorkflow(config.ciWorkflow, pr.headRefName);
      dispatched.push(pr.number);
    } catch (err) {
      failed.push(pr.number);
      core.warning(
        `dispatchMissingCi: dispatch failed for PR #${pr.number}: ${
          (err as Error).message
        }`,
      );
    }
  }

  return { dispatched, skipped, failed };
}
