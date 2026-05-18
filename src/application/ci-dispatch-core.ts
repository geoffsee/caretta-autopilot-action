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

/**
 * When the workflow's check_run has completed but the autopilot's pre-dispatch
 * `pending` commit status is still recorded under the same gate name, GitHub
 * collapses the two into one "Test" context on the PR rollup and shows
 * pending — blocking the PR even though the actual check passed. This writes
 * a matching commit status to clear the stale entry. Idempotent: it reads the
 * current state first and only writes when it disagrees with the conclusion.
 */
export async function reconcileGateCommitStatus(
  gh: GitHubClient,
  config: AutopilotConfig,
  pr: PullRequest,
  latestCheck: CheckRun | undefined,
  logPrefix: string,
): Promise<void> {
  if (config.dryRun || !config.enableDispatch) return;
  if (!latestCheck || latestCheck.status !== "completed") return;
  const target: "success" | "failure" =
    latestCheck.conclusion === "success" ? "success" : "failure";

  const current = await gh.getLatestCommitStatus(
    pr.headRefOid,
    config.testCheckName,
  );
  if (current === target) return;

  try {
    await gh.createCommitStatus(
      pr.headRefOid,
      target,
      config.testCheckName,
      `Autopilot synchronized "${config.testCheckName}" from completed check run`,
    );
    core.info(
      `${logPrefix}: reconciled "${config.testCheckName}" commit status to ${target} for PR #${pr.number} at SHA ${pr.headRefOid} (was ${current ?? "unset"})`,
    );
  } catch (err) {
    core.warning(
      `${logPrefix}: failed to reconcile commit status for PR #${pr.number}: ${(err as Error).message}`,
    );
  }
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
