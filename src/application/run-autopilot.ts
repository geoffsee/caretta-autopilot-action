import type { ExecClient } from "../../packages/action-common/src/exec-client.js";
import type { GitHubClient } from "../../packages/action-common/src/github-client.js";
import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  IssueCloseResult,
  PrCiResult,
} from "../../packages/action-common/src/types.js";
import { decideExecution } from "../domain/decide.js";
import { evaluate, findActiveSprint } from "../domain/evaluate.js";
import { buildSummary } from "../domain/summary.js";
import { closeIssuesForMergedPrs } from "./close-on-merge.js";
import { type ExecuteDeps, executeAutopilot } from "./execute-autopilot.js";
import { processAgentPRs } from "./pr-ci.js";

export interface AutopilotRunResult {
  evaluation: EvaluationResult;
  prCi: PrCiResult;
  decision: AutopilotDecision;
  closeOnMerge: IssueCloseResult;
  summary: string;
}

export async function runAutopilot(
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  _ref: string,
  executeDeps?: ExecuteDeps,
): Promise<AutopilotRunResult> {
  const initialIssues = await gh.listOpenIssues();
  const trackerNumber = findActiveSprint(initialIssues);
  const closeOnMerge = await closeIssuesForMergedPrs(
    gh,
    new Set(initialIssues.map((i) => i.number)),
    trackerNumber,
  );

  const closedSet = new Set(closeOnMerge.closed);
  const [issues, prs] = await Promise.all([
    closedSet.size === 0
      ? Promise.resolve(initialIssues)
      : Promise.resolve(initialIssues.filter((i) => !closedSet.has(i.number))),
    gh.listOpenPullRequests(),
  ]);
  const evaluation = evaluate(issues, prs);
  const prCi = await processAgentPRs(gh, prs, config);
  const decision = decideExecution(prCi, config);

  if (decision.targetDispatched === "executed") {
    await executeAutopilot(gh, exec, config, evaluation, executeDeps);
  }

  const summary = buildSummary(evaluation, prCi, decision, config);
  return { evaluation, prCi, decision, closeOnMerge, summary };
}
