import type { CheckRun, WorkflowRun } from "./types.js";

/**
 * True if `checkName` is the check GitHub should report for a branch-protection
 * / gate name of `gateName`.
 *
 * GitHub Actions uses `"{workflow name} / {job name}"` (e.g. `CI / Test`)
 * for check runs, while commit statuses and older setups often use just the job
 * id (e.g. `Test`). Autopilot's `test-check-name` defaults to the short form.
 *
 * Matching is symmetric so a gate of `CI / Test` still matches a lone `Test`
 * check name if GitHub ever returns the short form.
 */
export function matchesGateCheckName(
  checkName: string,
  gateName: string,
): boolean {
  if (checkName === gateName) return true;
  if (checkName.endsWith(` / ${gateName}`)) return true;
  if (gateName.endsWith(` / ${checkName}`)) return true;
  return false;
}

export function latestNamedCheck(
  checks: readonly CheckRun[],
  name: string,
): CheckRun | undefined {
  return [...checks]
    .filter((check) => matchesGateCheckName(check.name, name))
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
