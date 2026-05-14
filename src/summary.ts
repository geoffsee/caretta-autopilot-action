import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  PrCiResult,
} from "./types.js";

export function buildSummary(
  evaluation: EvaluationResult,
  prCi: PrCiResult,
  decision: AutopilotDecision,
  config: AutopilotConfig,
): string {
  const lines: string[] = [];
  lines.push("### Autopilot evaluation");
  lines.push("");
  lines.push(`- Open issues: ${evaluation.openIssueCount}`);
  lines.push(`- Open pull requests: ${evaluation.openPrCount}`);
  lines.push(`- Active sprint: ${evaluation.activeSprint}`);
  lines.push(`- PRs requiring attention: ${evaluation.stalePrCount}`);
  lines.push(`- Selected workflow: ${evaluation.workflow || "none"}`);
  lines.push(`- Reason: ${evaluation.reason}`);

  if (decision.targetBusy) {
    lines.push(
      `- Target workflow ${evaluation.workflow} is already queued or running; skipping dispatch.`,
    );
  }

  lines.push("");
  lines.push("### PR CI check");
  lines.push("");
  lines.push(
    `- Current agent PRs with a Test check on their head SHA: ${prCi.current.length}`,
  );
  lines.push(
    `- Agent PRs pending a Test check on their head SHA: ${prCi.pending.length}`,
  );
  lines.push(
    `- Agent PRs already queued/running CI for their head SHA: ${prCi.active.length}`,
  );
  lines.push(`- CI dispatches started: ${prCi.dispatched.length}`);
  lines.push(`- CI dispatches unavailable: ${prCi.failed.length}`);

  if (decision.holdTarget) {
    lines.push(
      "- Target workflow dispatch skipped this pass so pending tests can attach to the current PR heads.",
    );
  } else if (prCi.failed.length > 0) {
    lines.push(
      "- Target workflow dispatch may continue so the tracker loop can refresh branches that cannot dispatch CI yet.",
    );
  }

  if (
    config.dryRun &&
    evaluation.workflow &&
    !decision.targetBusy &&
    !decision.holdTarget
  ) {
    lines.push("");
    lines.push(`Dry run enabled; would dispatch ${evaluation.workflow}.`);
    if (evaluation.tracker) {
      lines.push(`Tracker: #${evaluation.tracker}`);
    }
  }

  return lines.join("\n");
}
