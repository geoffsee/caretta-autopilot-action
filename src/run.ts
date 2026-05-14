import { decideExecution } from "./decide.js";
import { evaluate } from "./evaluate.js";
import type { ExecClient } from "./exec.js";
import { type ExecuteDeps, executeAutopilot } from "./execute.js";
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
  _ref: string,
  executeDeps?: ExecuteDeps,
): Promise<AutopilotRunResult> {
  const [issues, prs] = await Promise.all([
    gh.listOpenIssues(),
    gh.listOpenPullRequests(),
  ]);
  const evaluation = evaluate(issues, prs);
  const prCi = await processAgentPRs(gh, prs, config);
  const decision = decideExecution(prCi, config);

  if (decision.targetDispatched === "executed") {
    await executeAutopilot(gh, exec, config, evaluation, executeDeps);
  }

  const summary = buildSummary(evaluation, prCi, decision, config);
  return { evaluation, prCi, decision, summary };
}
