import { describe, expect, test } from "bun:test";
import { buildSummary } from "../src/summary.js";
import { makeConfig } from "./fakes.js";
import type {
  AutopilotDecision,
  EvaluationResult,
  PrCiResult,
} from "../src/types.js";

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
  test.each([
    {
      name: "renders the evaluation block with counts and selected workflow",
      decision: { holdTarget: false, targetDispatched: "tracker", targetBusy: false },
      prCi: emptyPrCi,
      config: makeConfig(),
      expectedContains: ["### Autopilot evaluation", "- Open issues: 3", "- Open pull requests: 2", "- Active sprint: #7", "- Selected workflow: tracker-loop-dispatch.yml"],
    },
    {
      name: "notes when the target workflow is busy",
      decision: { holdTarget: false, targetDispatched: "skipped", targetBusy: true },
      prCi: emptyPrCi,
      config: makeConfig(),
      expectedContains: ["already queued or running"],
    },
    {
      name: "notes hold_target when PR-CI activity gates dispatch",
      decision: { holdTarget: true, targetDispatched: "skipped", targetBusy: false },
      prCi: emptyPrCi,
      config: makeConfig(),
      expectedContains: ["Target workflow dispatch skipped this pass"],
    },
    {
      name: "notes dispatch failures even when proceeding",
      decision: { holdTarget: false, targetDispatched: "tracker", targetBusy: false },
      prCi: { ...emptyPrCi, failed: [{ number: 1, branch: "agent/issue-1", sha: "sha", url: "u" }] },
      config: makeConfig(),
      expectedContains: ["Target workflow dispatch may continue"],
    },
    {
      name: "renders a dry-run footer when dispatch was held but no busy/hold",
      decision: { holdTarget: false, targetDispatched: "skipped", targetBusy: false },
      prCi: emptyPrCi,
      config: makeConfig({ dryRun: true }),
      expectedContains: ["Dry run enabled", "Tracker: #7"],
    },
  ])("$name", ({ decision, prCi, config, expectedContains }) => {
    const out = buildSummary(evalResult, prCi, decision, config);
    for (const text of expectedContains) {
      expect(out).toContain(text);
    }
  });
});
