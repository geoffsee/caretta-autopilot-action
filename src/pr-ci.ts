import * as core from "@actions/core";
import type { GitHubClient } from "./github.js";
import type {
  AutopilotConfig,
  PrCiResult,
  PrEntry,
  PullRequest,
} from "./types.js";

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
    const testChecks = checks.filter((c) => c.name === config.testCheckName);
    
    const latestCheck = testChecks.sort((a, b) => {
      const aTime = new Date(a.createdAt || a.startedAt || 0).getTime();
      const bTime = new Date(b.createdAt || b.startedAt || 0).getTime();
      return bTime - aTime;
    })[0];

    if (latestCheck?.conclusion === "success") {
      current.push(entry);
      continue;
    }

    const allRuns = await gh.listWorkflowRuns(config.ciWorkflow, undefined, pr.headRefName);
    const shaRuns = allRuns.filter((r) => r.headSha === pr.headRefOid);
    
    const activeRun = shaRuns.find((r) => r.status === "queued" || r.status === "in_progress");
    if (activeRun) {
      pending.push(entry);
      active.push(entry);
      continue;
    }

    pending.push(entry);

    if (config.dryRun || !config.enableDispatch) {
      continue;
    }

    const failedRun = shaRuns.sort((a, b) => b.id - a.id).find((r) => 
      r.conclusion === "failure" || r.conclusion === "cancelled" || r.conclusion === "timed_out"
    );

    try {
      // Create a pending status to ensure it registers in the PR rollup immediately.
      await gh.createCommitStatus(
        pr.headRefOid,
        "pending",
        config.testCheckName,
        failedRun ? "Autopilot rerunning failed CI..." : "Autopilot dispatching CI...",
      );

      if (failedRun) {
        core.info(
          `processAgentPRs: rerunning failed jobs for PR #${pr.number} (Run ID: ${failedRun.id}) at SHA ${pr.headRefOid}`,
        );
        await gh.reRunWorkflowFailedJobs(failedRun.id);
        dispatched.push(entry);
      } else {
        core.info(
          `processAgentPRs: dispatched ${config.ciWorkflow} for PR #${pr.number} (${pr.headRefName}) at SHA ${pr.headRefOid}`,
        );
        await gh.dispatchWorkflow(config.ciWorkflow, pr.headRefName);
        dispatched.push(entry);
      }
    } catch (err) {
      failed.push(entry);
      core.warning(
        `processAgentPRs: operation failed for PR #${pr.number}: ${
          (err as Error).message
        }`,
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
