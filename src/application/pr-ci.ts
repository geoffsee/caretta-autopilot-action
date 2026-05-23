import type { GitHubClient } from "@caretta/action-common/github-client";
import type {
  AutopilotConfig,
  PrCiResult,
  PrEntry,
  PullRequest,
} from "@caretta/action-common/types";
import {
  dispatchOrRerunCi,
  getPrCiSnapshot,
  isNamedCheckActivelyRunning,
  reconcileGateCommitStatus,
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

    // A completed check on this SHA is the authoritative result; the rollup
    // must reflect it regardless of conclusion. Reconciling only on success
    // (the 2026-05-18 fix's original scope) left failure shadowed behind the
    // pre-dispatch pending commit status, and re-dispatching on a SHA whose
    // check already concluded would just rewrite that pending and loop.
    if (snapshot.latestCheck?.status === "completed") {
      await reconcileGateCommitStatus(
        gh,
        config,
        pr,
        snapshot.latestCheck,
        "processAgentPRs",
      );
      if (snapshot.latestCheck.conclusion === "success") {
        current.push(entry);
      } else {
        failed.push(entry);
      }
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
