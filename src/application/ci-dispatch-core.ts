import * as core from "@actions/core";
import {
  activeRun,
  latestFailedRun,
  latestNamedCheck,
} from "../../packages/action-common/src/check-runs.js";
import type { GitHubClient } from "../../packages/action-common/src/github-client.js";
import type {
  AutopilotConfig,
  CheckRun,
  PullRequest,
  WorkflowRun,
} from "../../packages/action-common/src/types.js";

export interface PrCiSnapshot {
  readonly latestCheck?: CheckRun;
  readonly runInProgress?: WorkflowRun;
  readonly failedRun?: WorkflowRun;
}

/** True when the named check exists but has not finished (including pending commit statuses mapped to in_progress). */
export function isNamedCheckActivelyRunning(
  check: CheckRun | undefined,
): boolean {
  if (!check || check.conclusion === "success") return false;
  return check.status === "queued" || check.status === "in_progress";
}

export async function getPrCiSnapshot(
  gh: GitHubClient,
  config: AutopilotConfig,
  pr: PullRequest,
): Promise<PrCiSnapshot> {
  const checks = await gh.listCheckRuns(pr.headRefOid);
  const latestCheck = latestNamedCheck(checks, config.testCheckName);

  const allRuns = await gh.listWorkflowRuns(
    config.ciWorkflow,
    undefined,
    pr.headRefName,
  );
  const shaRuns = allRuns.filter((run) => run.headSha === pr.headRefOid);

  return {
    latestCheck,
    runInProgress: activeRun(shaRuns),
    failedRun: latestFailedRun(shaRuns),
  };
}

export async function dispatchOrRerunCi(
  gh: GitHubClient,
  config: AutopilotConfig,
  pr: PullRequest,
  failedRun: WorkflowRun | undefined,
  logPrefix: string,
): Promise<boolean> {
  try {
    if (failedRun) {
      core.info(
        `${logPrefix}: rerunning failed jobs for PR #${pr.number} (Run ID: ${failedRun.id}) at SHA ${pr.headRefOid}`,
      );
      await gh.reRunWorkflowFailedJobs(failedRun.id);
      await gh.createCommitStatus(
        pr.headRefOid,
        "pending",
        config.testCheckName,
        "Autopilot rerunning failed CI...",
      );
      return true;
    }

    core.info(
      `${logPrefix}: dispatching ${config.ciWorkflow} for PR #${pr.number} (${pr.headRefName}) at SHA ${pr.headRefOid}`,
    );
    await gh.dispatchWorkflow(config.ciWorkflow, pr.headRefName);
    await gh.createCommitStatus(
      pr.headRefOid,
      "pending",
      config.testCheckName,
      "Autopilot dispatching CI...",
    );
    return true;
  } catch (err) {
    const message = (err as Error).message;
    try {
      await gh.createCommitStatus(
        pr.headRefOid,
        "error",
        config.testCheckName,
        `Autopilot CI dispatch failed: ${message}`,
      );
    } catch (statusError) {
      core.warning(
        `${logPrefix}: failed to set error status for PR #${pr.number}: ${
          (statusError as Error).message
        }`,
      );
    }
    core.warning(
      `${logPrefix}: operation failed for PR #${pr.number}: ${message}`,
    );
    return false;
  }
}
