import { Container as InjectableDomainPolicy } from "di-framework/decorators";
import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  PrCiResult,
} from "../../packages/action-common/src/types.js";

@InjectableDomainPolicy({ singleton: false })
export class SummaryPolicy {
  build(
    evaluation: EvaluationResult,
    prCi: PrCiResult,
    decision: AutopilotDecision,
    config: AutopilotConfig,
  ): string {
    return buildSummary(evaluation, prCi, decision, config);
  }
}

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
  lines.push(`- Route: ${evaluation.route}`);
  lines.push(`- Reason: ${evaluation.reason}`);

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
      "- Execution skipped this pass so pending tests can attach to the current PR heads.",
    );
  } else if (prCi.failed.length > 0) {
    lines.push(
      "- Execution proceeded so the work-dispatch loop can refresh branches that cannot dispatch CI yet.",
    );
  }

  if (config.dryRun && !decision.holdTarget) {
    lines.push("");
    lines.push(`Dry run enabled; would execute ${evaluation.route} route.`);
    if (evaluation.tracker) {
      lines.push(`Tracker: #${evaluation.tracker}`);
    }
  }

  return lines.join("\n");
}
