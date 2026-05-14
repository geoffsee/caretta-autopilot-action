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
    const hasTest = checks.some((c) => c.name === config.testCheckName);
    if (hasTest) {
      current.push(entry);
      continue;
    }

    const [queued, inProgress] = await Promise.all([
      gh.listWorkflowRuns(config.ciWorkflow, "queued", pr.headRefName),
      gh.listWorkflowRuns(config.ciWorkflow, "in_progress", pr.headRefName),
    ]);
    const activeForSha =
      queued.filter((r) => r.headSha === pr.headRefOid).length +
      inProgress.filter((r) => r.headSha === pr.headRefOid).length;

    pending.push(entry);

    if (activeForSha > 0) {
      active.push(entry);
      continue;
    }

    if (config.dryRun || !config.enableDispatch) {
      continue;
    }

    try {
      await gh.dispatchWorkflow(config.ciWorkflow, pr.headRefName);
      dispatched.push(entry);
    } catch {
      failed.push(entry);
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
