import type { ExecClient } from "@caretta/action-common/exec-client";
import type { GitHubClient } from "@caretta/action-common/github-client";
import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  IssueCloseResult,
  PrCiResult,
} from "@caretta/action-common/types";
import {
  Component as Inject,
  Container as InjectableUseCase,
} from "di-framework/decorators";
import {
  AutopilotDomainLogic,
  type AutopilotDomainModel,
  functionalAutopilotDomainModel,
} from "../domain/autopilot-domain.js";
import { closeIssuesForMergedPrs } from "./close-on-merge.js";
import {
  type ExecuteDeps,
  executeAutopilot,
  resolveDirtyAgentPRs,
  reviewAndFixAgentPRs,
} from "./execute-autopilot.js";
import { processAgentPRs } from "./pr-ci.js";

export interface AutopilotRunResult {
  evaluation: EvaluationResult;
  prCi: PrCiResult;
  decision: AutopilotDecision;
  closeOnMerge: IssueCloseResult;
  summary: string;
}

export type RunAutopilotUseCase = (
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  ref: string,
) => Promise<AutopilotRunResult>;

@InjectableUseCase({ singleton: false })
export class AutopilotUseCase {
  constructor(
    @Inject(AutopilotDomainLogic)
    private readonly domain: AutopilotDomainModel,
  ) {}

  async run(
    gh: GitHubClient,
    exec: ExecClient,
    config: AutopilotConfig,
    ref: string,
    executeDeps?: ExecuteDeps,
  ): Promise<AutopilotRunResult> {
    return runAutopilot(gh, exec, config, ref, executeDeps, this.domain);
  }
}

export async function runAutopilot(
  gh: GitHubClient,
  exec: ExecClient,
  config: AutopilotConfig,
  _ref: string,
  executeDeps?: ExecuteDeps,
  domain: AutopilotDomainModel = functionalAutopilotDomainModel,
): Promise<AutopilotRunResult> {
  const initialIssues = await gh.listOpenIssues();
  const trackerNumber = domain.findActiveSprint(initialIssues);
  const closeOnMerge = await closeIssuesForMergedPrs(
    gh,
    new Set(initialIssues.map((i) => i.number)),
    trackerNumber,
  );

  const closedSet = new Set(closeOnMerge.closed);
  const [issues, initialPrs] = await Promise.all([
    closedSet.size === 0
      ? Promise.resolve(initialIssues)
      : Promise.resolve(initialIssues.filter((i) => !closedSet.has(i.number))),
    gh.listOpenPullRequests(),
  ]);

  // Resolve DIRTY agent PRs before the hold decision. Conflict resolution is
  // non-disruptive (it doesn't dispatch new work or re-run others' CI), so it
  // shouldn't be gated by another PR's pending CI.
  const dirtyResolved = await resolveDirtyAgentPRs(
    gh,
    exec,
    config,
    initialPrs,
    executeDeps,
  );
  const prsAfterDirty = dirtyResolved
    ? await gh.listOpenPullRequests()
    : initialPrs;

  // Same rationale for code-review/fix-pr remediation on existing PRs: it acts
  // on PRs whose CI is already complete (success or failure), so it should not
  // be gated by another agent PR's in-flight CI or by `processAgentPRs`'s own
  // rerun-of-failing-CI side effect.
  const reviewed = await reviewAndFixAgentPRs(
    gh,
    exec,
    config,
    prsAfterDirty,
    executeDeps,
  );
  const prs = reviewed ? await gh.listOpenPullRequests() : prsAfterDirty;

  const evaluation = domain.evaluate(issues, prs);
  let prCi = await processAgentPRs(gh, prs, config);
  const decision = domain.decideExecution(prCi, config);

  if (decision.targetDispatched === "executed") {
    await executeAutopilot(gh, exec, config, evaluation, executeDeps);
    // Commits pushed with the default GITHUB_TOKEN do not trigger push/pull_request
    // workflows; re-scan and dispatch CI for any new PR tips.
    const prsAfterExecute = await gh.listOpenPullRequests();
    prCi = await processAgentPRs(gh, prsAfterExecute, config);
  }

  const summary = domain.buildSummary(evaluation, prCi, decision, config);
  return { evaluation, prCi, decision, closeOnMerge, summary };
}
