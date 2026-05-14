import type { EvaluationResult, Issue, PullRequest } from "./types.js";

export function findActiveSprint(issues: readonly Issue[]): number | null {
  const sprints = [...issues].filter((i) =>
    i.labels.some((l) => l.name === "sprint"),
  );
  if (sprints.length === 0) return null;
  sprints.sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
  return sprints[0].number;
}

export function countStalePRs(prs: readonly PullRequest[]): number {
  return prs.filter(
    (p) =>
      !p.isDraft &&
      (p.reviewDecision === "CHANGES_REQUESTED" ||
        p.reviewDecision === "REVIEW_REQUIRED"),
  ).length;
}

export function evaluate(
  issues: readonly Issue[],
  prs: readonly PullRequest[],
  trackerWorkflow: string,
  factoryWorkflow: string,
): EvaluationResult {
  const sprint = findActiveSprint(issues);
  const openIssueCount = issues.length;
  const openPrCount = prs.length;
  const stalePrCount = countStalePRs(prs);

  if (sprint !== null) {
    return {
      sprint,
      openIssueCount,
      openPrCount,
      stalePrCount,
      workflow: trackerWorkflow,
      tracker: String(sprint),
      reason: `open sprint #${sprint} found; dispatching tracker loop`,
      activeSprint: `#${sprint}`,
    };
  }

  return {
    sprint: null,
    openIssueCount,
    openPrCount,
    stalePrCount,
    workflow: factoryWorkflow,
    tracker: "",
    reason: "no open sprint found; dispatching factory cycle",
    activeSprint: "none",
  };
}
