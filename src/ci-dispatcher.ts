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
    return { dispatched: [], skipped: [], failed: [] };
  }

  const scope = options.issueNumbers
    ? new Set(options.issueNumbers.map(String))
    : undefined;

  const prs = await gh.listOpenPullRequests();
  const eligible = prs.filter((pr) => {
    if (pr.isDraft) return false;
    if (!config.agentBranchPattern.test(pr.headRefName)) return false;
    if (!scope) return true;
    const m = pr.headRefName.match(/^agent\/issue-([0-9]+)$/);
    return !!m && scope.has(m[1]);
  });

  const dispatched: number[] = [];
  const skipped: number[] = [];
  const failed: number[] = [];

  for (const pr of eligible) {
    const checks = await gh.listCheckRuns(pr.headRefOid);
    if (checks.some((c) => c.name === config.testCheckName)) {
      skipped.push(pr.number);
      continue;
    }

    const [queued, inProgress] = await Promise.all([
      gh.listWorkflowRuns(config.ciWorkflow, "queued", pr.headRefName),
      gh.listWorkflowRuns(config.ciWorkflow, "in_progress", pr.headRefName),
    ]);
    const activeForSha =
      queued.filter((r) => r.headSha === pr.headRefOid).length +
      inProgress.filter((r) => r.headSha === pr.headRefOid).length;
    if (activeForSha > 0) {
      skipped.push(pr.number);
      continue;
    }

    try {
      await gh.dispatchWorkflow(config.ciWorkflow, pr.headRefName);
      dispatched.push(pr.number);
      core.info(
        `dispatchMissingCi: dispatched ${config.ciWorkflow} for PR #${pr.number} (${pr.headRefName})`,
      );
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
