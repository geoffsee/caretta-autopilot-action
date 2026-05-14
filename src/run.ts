import { isWorkflowBusy } from "./activity.js";
import { dispatchTarget } from "./decide.js";
import { evaluate } from "./evaluate.js";
import { executeAutopilot } from "./execute.js";
import type { ExecClient } from "./exec.js";
import type { GitHubClient } from "./github.js";
import { processAgentPRs } from "./pr-ci.js";
import { buildSummary } from "./summary.js";
import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  PrCiResult,
} from "./types.js";

export interface AutopilotRunResult {
  evaluation: EvaluationResult;
  prCi: PrCiResult;
  decision: AutopilotDecision;
  summary: string;
}

export async function runAutopilot(
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  ref: string,
): Promise<AutopilotRunResult> {
  const [issues, prs] = await Promise.all([
    gh.listOpenIssues(),
    gh.listOpenPullRequests(),
  ]);
  const evaluation = evaluate(
    issues,
    prs,
    config.trackerWorkflow,
    config.factoryWorkflow,
  );
  const targetBusy = await isWorkflowBusy(gh, evaluation.workflow);
  const prCi = targetBusy
    ? { pending: [], dispatched: [], active: [], current: [], failed: [] }
    : await processAgentPRs(gh, prs, config);
  const decision = await dispatchTarget(
    gh,
    evaluation,
    prCi,
    config,
    ref,
    targetBusy,
  );

  if (decision.targetDispatched === "executed") {
    await executeAutopilot(gh, exec, config, evaluation);
  }

  const summary = buildSummary(evaluation, prCi, decision, config);
  return { evaluation, prCi, decision, summary };
}
