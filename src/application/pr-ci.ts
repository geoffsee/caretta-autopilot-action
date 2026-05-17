import * as core from "@actions/core";
import {
  activeRun,
  latestFailedRun,
  latestNamedCheck,
} from "../../packages/action-common/src/check-runs.js";
import type { GitHubClient } from "../../packages/action-common/src/github-client.js";
import type {
  AutopilotConfig,
  PrCiResult,
  PrEntry,
  PullRequest,
} from "../../packages/action-common/src/types.js";

export function filterAgentPRs(
  prs: readonly PullRequest[],
  pattern: RegExp,
): PullRequest[] {
  return prs.filter(
    (p) =>
      !p.isDraft &&
      p.mergeStateStatus !== "DIRTY" &&
      pattern.test(p.headRefName),
  );
}

function toEntry(pr: PullRequest): PrEntry {
  return {
    number: pr.number,
    branch: pr.headRefName,
    sha: pr.headRefOid,
    url: pr.url,
  };
}

export async function processAgentPRs(
  gh: GitHubClient,
  prs: readonly PullRequest[],
  config: AutopilotConfig,
): Promise<PrCiResult> {
  const eligible = filterAgentPRs(prs, config.agentBranchPattern);
  const pending: PrEntry[] = [];
  const dispatched: PrEntry[] = [];
  const active: PrEntry[] = [];
  const current: PrEntry[] = [];
  const failed: PrEntry[] = [];

  for (const pr of eligible) {
    const entry = toEntry(pr);
    const checks = await gh.listCheckRuns(pr.headRefOid);
    const latestCheck = latestNamedCheck(checks, config.testCheckName);

    if (latestCheck?.conclusion === "success") {
      current.push(entry);
      continue;
    }

    const allRuns = await gh.listWorkflowRuns(
      config.ciWorkflow,
      undefined,
      pr.headRefName,
    );
    const shaRuns = allRuns.filter((r) => r.headSha === pr.headRefOid);

    const runInProgress = activeRun(shaRuns);
    if (runInProgress) {
      pending.push(entry);
      active.push(entry);
      continue;
    }

    pending.push(entry);

    if (config.dryRun || !config.enableDispatch) {
      continue;
    }

    const failedRun = latestFailedRun(shaRuns);

    try {
      if (failedRun) {
        core.info(
          `processAgentPRs: rerunning failed jobs for PR #${pr.number} (Run ID: ${failedRun.id}) at SHA ${pr.headRefOid}`,
        );
        await gh.reRunWorkflowFailedJobs(failedRun.id);
        await gh.createCommitStatus(
          pr.headRefOid,
          "pending",
          config.testCheckName,
          "Autopilot rerunning failed CI...",
        );
        dispatched.push(entry);
      } else {
        core.info(
          `processAgentPRs: dispatched ${config.ciWorkflow} for PR #${pr.number} (${pr.headRefName}) at SHA ${pr.headRefOid}`,
        );
        await gh.dispatchWorkflow(config.ciWorkflow, pr.headRefName);
        await gh.createCommitStatus(
          pr.headRefOid,
          "pending",
          config.testCheckName,
          "Autopilot dispatching CI...",
        );
        dispatched.push(entry);
      }
    } catch (err) {
      const message = (err as Error).message;
      failed.push(entry);
      try {
        await gh.createCommitStatus(
          pr.headRefOid,
          "error",
          config.testCheckName,
          `Autopilot CI dispatch failed: ${message}`,
        );
      } catch (statusError) {
        core.warning(
          `processAgentPRs: failed to set error status for PR #${pr.number}: ${
            (statusError as Error).message
          }`,
        );
      }
      core.warning(
        `processAgentPRs: operation failed for PR #${pr.number}: ${message}`,
      );
    }
  }

  return {
    pending,
    dispatched,
    active,
    current,
    failed,
  };
}
