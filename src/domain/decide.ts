import type {
  AutopilotConfig,
  AutopilotDecision,
  PrCiResult,
} from "../../packages/action-common/src/types.js";

export function computeHoldTarget(prCi: PrCiResult, dryRun: boolean): boolean {
  const holdCount = prCi.dispatched.length + prCi.active.length;
  if (holdCount > 0) return true;
  if (dryRun && prCi.pending.length > 0) return true;
  return false;
}

export function decideExecution(
  prCi: PrCiResult,
  config: AutopilotConfig,
): AutopilotDecision {
  const holdTarget = computeHoldTarget(prCi, config.dryRun);
  if (holdTarget || config.dryRun || !config.enableDispatch) {
    return { holdTarget, targetDispatched: "skipped" };
  }
  return { holdTarget, targetDispatched: "executed" };
}
