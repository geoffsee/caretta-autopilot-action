import type { CheckRun, WorkflowRun } from "./types.js";

export function latestNamedCheck(
  checks: readonly CheckRun[],
  name: string,
): CheckRun | undefined {
  return [...checks]
    .filter((check) => check.name === name)
    .sort((a, b) => checkTime(b) - checkTime(a))[0];
}

export function latestFailedRun(
  runs: readonly WorkflowRun[],
): WorkflowRun | undefined {
  return [...runs]
    .sort((a, b) => b.id - a.id)
    .find(
      (run) =>
        run.conclusion === "failure" ||
        run.conclusion === "cancelled" ||
        run.conclusion === "timed_out",
    );
}

export function activeRun(
  runs: readonly WorkflowRun[],
): WorkflowRun | undefined {
  return runs.find(
    (run) => run.status === "queued" || run.status === "in_progress",
  );
}

function checkTime(check: CheckRun): number {
  return new Date(check.createdAt || check.startedAt || 0).getTime();
}
