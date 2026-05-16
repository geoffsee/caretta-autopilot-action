import { closeIssuesForMergedPrs } from "./close-on-merge.js";
import { decideExecution } from "./decide.js";
import { evaluate, findActiveSprint } from "./evaluate.js";
import type { ExecClient } from "./exec.js";
import { type ExecuteDeps, executeAutopilot } from "./execute.js";
import type { GitHubClient } from "./github.js";
import { processAgentPRs } from "./pr-ci.js";
import { buildSummary } from "./summary.js";
import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  IssueCloseResult,
  PrCiResult,
} from "./types.js";

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
