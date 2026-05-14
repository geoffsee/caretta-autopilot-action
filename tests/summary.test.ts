import { describe, expect, test } from "bun:test";
import { buildSummary } from "../src/summary.js";
import { makeConfig } from "./fakes.js";
import type { AutopilotDecision, EvaluationResult, PrCiResult } from "../src/types.js";

const evalResult: EvaluationResult = {
  sprint: 7,
  openIssueCount: 3,
  openPrCount: 2,
  stalePrCount: 1,
  workflow: "tracker-loop-dispatch.yml",
  tracker: "7",
  reason: "open sprint #7 found; dispatching tracker loop",
  activeSprint: "#7",
};

const emptyPrCi: PrCiResult = {
  pending: [],
  dispatched: [],
  active: [],
  current: [],
  failed: [],
};

describe("buildSummary", () => {
  test("renders the evaluation block with counts and selected workflow", () => {
    const decision: AutopilotDecision = {
      holdTarget: false,
      targetDispatched: "tracker",
      targetBusy: false,
    };
    const out = buildSummary(evalResult, emptyPrCi, decision, makeConfig());
    expect(out).toContain("### Autopilot evaluation");
    expect(out).toContain("- Open issues: 3");
    expect(out).toContain("- Open pull requests: 2");
    expect(out).toContain("- Active sprint: #7");
    expect(out).toContain("- Selected workflow: tracker-loop-dispatch.yml");
  });

  test("notes when the target workflow is busy", () => {
    const decision: AutopilotDecision = {
      holdTarget: false,
      targetDispatched: "skipped",
      targetBusy: true,
    };
    const out = buildSummary(evalResult, emptyPrCi, decision, makeConfig());
    expect(out).toContain("already queued or running");
  });

  test("notes hold_target when PR-CI activity gates dispatch", () => {
    const decision: AutopilotDecision = {
      holdTarget: true,
      targetDispatched: "skipped",
      targetBusy: false,
    };
    const out = buildSummary(evalResult, emptyPrCi, decision, makeConfig());
    expect(out).toContain("Target workflow dispatch skipped this pass");
  });

  test("notes dispatch failures even when proceeding", () => {
    const decision: AutopilotDecision = {
      holdTarget: false,
      targetDispatched: "tracker",
      targetBusy: false,
    };
    const prCi: PrCiResult = {
      ...emptyPrCi,
      failed: [{ number: 1, branch: "agent/issue-1", sha: "sha", url: "u" }],
    };
    const out = buildSummary(evalResult, prCi, decision, makeConfig());
    expect(out).toContain("Target workflow dispatch may continue");
  });

  test("renders a dry-run footer when dispatch was held but no busy/hold", () => {
    const decision: AutopilotDecision = {
      holdTarget: false,
      targetDispatched: "skipped",
      targetBusy: false,
    };
    const out = buildSummary(evalResult, emptyPrCi, decision, makeConfig({ dryRun: true }));
    expect(out).toContain("Dry run enabled");
    expect(out).toContain("Tracker: #7");
  });
});
