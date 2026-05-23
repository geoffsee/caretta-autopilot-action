import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  Issue,
  PrCiResult,
  PullRequest,
} from "@caretta/action-common/types";
import {
  Component as Inject,
  Container as InjectableDomainModel,
} from "di-framework/decorators";
import {
  computeHoldTarget,
  decideExecution,
  ExecutionDecisionPolicy,
} from "./decide.js";
import { EvaluationPolicy, evaluate, findActiveSprint } from "./evaluate.js";
import { buildSummary, SummaryPolicy } from "./summary.js";
import {
  decideTrigger,
  type TriggerDecision,
  type TriggerInputs,
  TriggerPolicy,
} from "./trigger.js";

export interface AutopilotDomainModel {
  decideTrigger(inputs: TriggerInputs): TriggerDecision;
  findActiveSprint(issues: readonly Issue[]): number | null;
  evaluate(
    issues: readonly Issue[],
    prs: readonly PullRequest[],
  ): EvaluationResult;
  computeHoldTarget(prCi: PrCiResult, dryRun: boolean): boolean;
  decideExecution(prCi: PrCiResult, config: AutopilotConfig): AutopilotDecision;
  buildSummary(
    evaluation: EvaluationResult,
    prCi: PrCiResult,
    decision: AutopilotDecision,
    config: AutopilotConfig,
  ): string;
}

@InjectableDomainModel({ singleton: false })
export class AutopilotDomainLogic implements AutopilotDomainModel {
  constructor(
    @Inject(TriggerPolicy)
    private readonly triggers: TriggerPolicy,
    @Inject(EvaluationPolicy)
    private readonly evaluation: EvaluationPolicy,
    @Inject(ExecutionDecisionPolicy)
    private readonly decisions: ExecutionDecisionPolicy,
    @Inject(SummaryPolicy)
    private readonly summaries: SummaryPolicy,
  ) {}

  decideTrigger(inputs: TriggerInputs): TriggerDecision {
    return this.triggers.decide(inputs);
  }

  findActiveSprint(issues: readonly Issue[]): number | null {
    return this.evaluation.findActiveSprint(issues);
  }

  evaluate(
    issues: readonly Issue[],
    prs: readonly PullRequest[],
  ): EvaluationResult {
    return this.evaluation.evaluate(issues, prs);
  }

  computeHoldTarget(prCi: PrCiResult, dryRun: boolean): boolean {
    return this.decisions.computeHoldTarget(prCi, dryRun);
  }

  decideExecution(
    prCi: PrCiResult,
    config: AutopilotConfig,
  ): AutopilotDecision {
    return this.decisions.decide(prCi, config);
  }

  buildSummary(
    evaluation: EvaluationResult,
    prCi: PrCiResult,
    decision: AutopilotDecision,
    config: AutopilotConfig,
  ): string {
    return this.summaries.build(evaluation, prCi, decision, config);
  }
}

export const functionalAutopilotDomainModel: AutopilotDomainModel = {
  decideTrigger,
  findActiveSprint,
  evaluate,
  computeHoldTarget,
  decideExecution,
  buildSummary,
};
