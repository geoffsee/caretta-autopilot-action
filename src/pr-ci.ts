import type { GitHubClient } from "./github.js";
import type { AutopilotConfig, PrCiResult, PrEntry, PullRequest } from "./types.js";

export function filterAgentPRs(prs: PullRequest[], pattern: RegExp): PullRequest[] {
  return prs.filter(
    (p) => !p.isDraft && p.mergeStateStatus !== "DIRTY" && pattern.test(p.headRefName),
  );
}

function toEntry(pr: PullRequest): PrEntry {
  return { number: pr.number, branch: pr.headRefName, sha: pr.headRefOid, url: pr.url };
}

export async function processAgentPRs(
  gh: GitHubClient,
  prs: PullRequest[],
  config: AutopilotConfig,
): Promise<PrCiResult> {
  const eligible = filterAgentPRs(prs, config.agentBranchPattern);
  const result: PrCiResult = {
    pending: [],
    dispatched: [],
    active: [],
    current: [],
    failed: [],
  };

  for (const pr of eligible) {
    const entry = toEntry(pr);
    const checks = await gh.listCheckRuns(pr.headRefOid);
    const hasTest = checks.some((c) => c.name === config.testCheckName);
    if (hasTest) {
      result.current.push(entry);
      continue;
    }

    const [queued, inProgress] = await Promise.all([
      gh.listWorkflowRuns(config.ciWorkflow, "queued", pr.headRefName),
      gh.listWorkflowRuns(config.ciWorkflow, "in_progress", pr.headRefName),
    ]);
    const activeForSha =
      queued.filter((r) => r.headSha === pr.headRefOid).length +
      inProgress.filter((r) => r.headSha === pr.headRefOid).length;

    result.pending.push(entry);

    if (activeForSha > 0) {
      result.active.push(entry);
      continue;
    }

    if (config.dryRun || !config.enableDispatch) {
      continue;
    }

    try {
      await gh.dispatchWorkflow(config.ciWorkflow, pr.headRefName);
      result.dispatched.push(entry);
    } catch {
      result.failed.push(entry);
    }
  }

  return result;
}
