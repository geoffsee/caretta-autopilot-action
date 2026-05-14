import type { GitHubClient } from "./github.js";
import type { AutopilotConfig, AutopilotDecision, EvaluationResult, PrCiResult } from "./types.js";

export function computeHoldTarget(prCi: PrCiResult, dryRun: boolean): boolean {
  const holdCount = prCi.dispatched.length + prCi.active.length;
  if (holdCount > 0) return true;
  if (dryRun && prCi.pending.length > 0) return true;
  return false;
}

export async function dispatchTarget(
  gh: GitHubClient,
  evaluation: EvaluationResult,
  prCi: PrCiResult,
  config: AutopilotConfig,
  ref: string,
  targetBusy: boolean,
): Promise<AutopilotDecision> {
  const holdTarget = computeHoldTarget(prCi, config.dryRun);

  if (targetBusy || holdTarget || config.dryRun) {
    return { holdTarget, targetDispatched: "skipped", targetBusy };
  }

  if (evaluation.workflow === config.trackerWorkflow) {
    await gh.dispatchWorkflow(config.trackerWorkflow, ref, {
      tracker: evaluation.tracker,
      context: config.context,
    });
    return { holdTarget, targetDispatched: "tracker", targetBusy };
  }

  if (evaluation.workflow === config.factoryWorkflow) {
    await gh.dispatchWorkflow(config.factoryWorkflow, ref, {
      context: config.context,
    });
    return { holdTarget, targetDispatched: "factory", targetBusy };
  }

  return { holdTarget, targetDispatched: "skipped", targetBusy };
}
