/**
 * Machine-readable behavior contracts for `@caretta/autopilot-action`.
 *
 * Each contract has a stable ID. Tests in this directory SHOULD reference the
 * same ID in their title (`test("AP-…: …")`) so failures map directly to a
 * declared guarantee. When behavior intentionally changes, update this file
 * and the linked test in the same change — never "fix" drift by weakening tests
 * without updating the contract declaration.
 */

export type BehaviorDomain =
  | "trigger"
  | "evaluation"
  | "decision"
  | "pipeline"
  | "action_io";

export interface BehaviorContract {
  readonly id: string;
  readonly domain: BehaviorDomain;
  /** Single sentence: what the product promises operators and integrators. */
  readonly statement: string;
}

/**
 * Ordered catalog of behavioral guarantees. IDs use a short prefix per domain:
 * AP-TR trigger, AP-EV evaluation, AP-DC decision, AP-RN pipeline/run, AP-IO action I/O.
 */
export const BEHAVIOR_CONTRACTS: readonly BehaviorContract[] = [
  {
    id: "AP-TR-001",
    domain: "trigger",
    statement:
      "The action runs on `schedule` events (heartbeat) so unattended repos keep evaluating.",
  },
  {
    id: "AP-TR-002",
    domain: "trigger",
    statement:
      "The action runs on `workflow_dispatch` so operators can invoke autopilot manually.",
  },
  {
    id: "AP-TR-003",
    domain: "trigger",
    statement:
      "On `issues`, the action runs when the issue has the `sprint` label.",
  },
  {
    id: "AP-TR-004",
    domain: "trigger",
    statement:
      "On `issues`, the action runs on `closed` even without sprint labels so merge/order cleanup can run.",
  },
  {
    id: "AP-TR-005",
    domain: "trigger",
    statement:
      "On `issues`, non-closed events without the sprint label do not run autopilot.",
  },
  {
    id: "AP-TR-006",
    domain: "trigger",
    statement:
      "On `pull_request`, events whose head ref matches the agent branch prefix run autopilot.",
  },
  {
    id: "AP-TR-007",
    domain: "trigger",
    statement:
      "On `pull_request`, non-agent head branches do not run autopilot.",
  },
  {
    id: "AP-TR-008",
    domain: "trigger",
    statement:
      "On `workflow_run`, completions for agent head branches run autopilot.",
  },
  {
    id: "AP-TR-009",
    domain: "trigger",
    statement: "On `workflow_run`, non-agent branches do not run autopilot.",
  },
  {
    id: "AP-TR-010",
    domain: "trigger",
    statement: "Unknown GitHub event names are ignored (no autopilot run).",
  },
  {
    id: "AP-EV-001",
    domain: "evaluation",
    statement:
      "When an active sprint tracker exists, evaluation routes to `work` and exposes the sprint issue number as `tracker`.",
  },
  {
    id: "AP-EV-002",
    domain: "evaluation",
    statement:
      "When no sprint exists, evaluation routes to `factory` and leaves `tracker` empty with a documented reason.",
  },
  {
    id: "AP-EV-003",
    domain: "evaluation",
    statement:
      "Among sprint-labeled issues, the newest `tracker`-labeled issue wins; otherwise any sprint-labeled issue by recency.",
  },
  {
    id: "AP-DC-001",
    domain: "decision",
    statement:
      "If any agent PRs are mid-flight (dispatched batch or active CI), the work/factory execution step is skipped to avoid overlapping runs.",
  },
  {
    id: "AP-DC-002",
    domain: "decision",
    statement:
      "In dry-run, pending agent PRs also skip the execution step (no caretta subprocess for dispatch).",
  },
  {
    id: "AP-DC-003",
    domain: "decision",
    statement:
      "When not holding, not dry-run, and dispatch is enabled, caretta execution (`targetDispatched: executed`) is allowed.",
  },
  {
    id: "AP-RN-001",
    domain: "pipeline",
    statement:
      "With factory routing and a clear execution decision, autopilot installs/runs caretta (housekeeping path) — the action does more than GitHub classification.",
  },
  {
    id: "AP-RN-002",
    domain: "pipeline",
    statement:
      "When the execution decision is `skipped`, no caretta subprocess runs (zero exec calls).",
  },
  {
    id: "AP-IO-001",
    domain: "action_io",
    statement:
      "The action sets a stable set of step outputs derived from evaluation, PR CI buckets, and execution decision.",
  },
  {
    id: "AP-IO-002",
    domain: "action_io",
    statement:
      "Unset optional inputs fall back to documented defaults (version, agent, context, CI workflow name, git identity, enable-dispatch sentinel).",
  },
] as const;

export function contractById(id: string): BehaviorContract {
  const c = BEHAVIOR_CONTRACTS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown behavior contract id: ${id}`);
  return c;
}
