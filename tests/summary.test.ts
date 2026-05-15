import { describe, expect, test } from "bun:test";
import { buildSummary } from "../src/summary.js";
import type { EvaluationResult, PrCiResult } from "../src/types.js";
import { makeConfig } from "./fakes.js";

const workEval: EvaluationResult = {
  route: "work",
  sprint: 7,
  openIssueCount: 3,
  openPrCount: 2,
  stalePrCount: 1,
  tracker: "7",
  reason: "open sprint #7 found; running work dispatch",
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
      name: "renders the evaluation block with counts and route",
      decision: { holdTarget: false, targetDispatched: "executed" as const },
      prCi: emptyPrCi,
      config: makeConfig(),
      expectedContains: [
        "### Autopilot evaluation",
        "- Open issues: 3",
        "- Open pull requests: 2",
        "- Active sprint: #7",
        "- Route: work",
      ],
    },
    {
      name: "notes hold_target when PR-CI activity gates execution",
      decision: { holdTarget: true, targetDispatched: "skipped" as const },
      prCi: emptyPrCi,
      config: makeConfig(),
      expectedContains: ["Execution skipped this pass"],
    },
    {
      name: "notes dispatch failures even when proceeding",
      decision: { holdTarget: false, targetDispatched: "executed" as const },
      prCi: {
        ...emptyPrCi,
        failed: [{ number: 1, branch: "agent/issue-1", sha: "sha", url: "u" }],
      },
      config: makeConfig(),
      expectedContains: ["Execution proceeded"],
    },
    {
      name: "renders a dry-run footer with the would-execute route",
      decision: { holdTarget: false, targetDispatched: "skipped" as const },
      prCi: emptyPrCi,
      config: makeConfig({ dryRun: true }),
      expectedContains: [
        "Dry run enabled",
        "would execute work route",
        "Tracker: #7",
      ],
    },
  ])("$name", ({ decision, prCi, config, expectedContains }) => {
    const out = buildSummary(workEval, prCi, decision, config);
    for (const text of expectedContains) {
      expect(out).toContain(text);
    }
  });
});
