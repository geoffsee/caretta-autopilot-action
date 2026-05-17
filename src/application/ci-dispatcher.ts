import * as core from "@actions/core";
import type { GitHubClient } from "../../packages/action-common/src/github-client.js";
import type { AutopilotConfig } from "../../packages/action-common/src/types.js";
import { dispatchOrRerunCi, getPrCiSnapshot } from "./ci-dispatch-core.js";

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
    core.info(
      `dispatchMissingCi: skipping (dryRun=${config.dryRun}, enableDispatch=${config.enableDispatch})`,
    );
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
  core.info(
    `dispatchMissingCi: ${eligible.length} PRs match agent branch pattern`,
  );

  const dispatched: number[] = [];
  const skipped: number[] = [];
  const failed: number[] = [];

  for (const pr of eligible) {
    const m = pr.headRefName.match(/^agent\/issue-([0-9]+)$/);
    const issueNum = m ? m[1] : undefined;

    if (scope && (!issueNum || !scope.has(issueNum))) {
      core.info(
        `dispatchMissingCi: skipping PR #${pr.number} (${pr.headRefName}) - not in current issue scope`,
      );
      continue;
    }

    const snapshot = await getPrCiSnapshot(gh, config, pr);

    if (snapshot.latestCheck?.conclusion === "success") {
      core.info(
        `dispatchMissingCi: PR #${pr.number} already has a successful "${config.testCheckName}" check.`,
      );
      skipped.push(pr.number);
      continue;
    }

    if (snapshot.runInProgress) {
      core.info(
        `dispatchMissingCi: PR #${pr.number} has an active workflow run (ID: ${snapshot.runInProgress.id}) for SHA ${pr.headRefOid}`,
      );
      skipped.push(pr.number);
      continue;
    }

    const ok = await dispatchOrRerunCi(
      gh,
      config,
      pr,
      snapshot.failedRun,
      "dispatchMissingCi",
    );
    if (ok) {
      dispatched.push(pr.number);
    } else {
      failed.push(pr.number);
    }
  }

  return { dispatched, skipped, failed };
}
