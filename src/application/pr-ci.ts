import type { GitHubClient } from "../../packages/action-common/src/github-client.js";
import type {
  AutopilotConfig,
  PrCiResult,
  PrEntry,
  PullRequest,
} from "../../packages/action-common/src/types.js";
import {
  dispatchOrRerunCi,
  getPrCiSnapshot,
  isNamedCheckActivelyRunning,
} from "./ci-dispatch-core.js";

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
    const snapshot = await getPrCiSnapshot(gh, config, pr);

    if (snapshot.latestCheck?.conclusion === "success") {
      current.push(entry);
      continue;
    }

    if (isNamedCheckActivelyRunning(snapshot.latestCheck)) {
      pending.push(entry);
      active.push(entry);
      continue;
    }

    if (snapshot.runInProgress) {
      pending.push(entry);
      active.push(entry);
      continue;
    }

    pending.push(entry);

    if (config.dryRun || !config.enableDispatch) {
      continue;
    }

    const ok = await dispatchOrRerunCi(
      gh,
      config,
      pr,
      snapshot.failedRun,
      "processAgentPRs",
    );
    if (ok) {
      dispatched.push(entry);
    } else {
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
