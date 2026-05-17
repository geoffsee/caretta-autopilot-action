/**
 * Behavior contract suite: GitHub Action entrypoint (`main`) — inputs/outputs.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  coreCapture,
  installGithubActionsMocks,
  resetGithubActionsCapture,
} from "./utils/github-actions-mock.js";
import {
  makeDecision,
  makeEvaluation,
  makeMainHarness,
  makePrCi,
  makeRunResult,
} from "./utils/main-harness.js";

installGithubActionsMocks();

const { main } = await import("../../src/main.js");

/** Stable output names workflows may depend on — keep in sync with action.yaml if present. */
const REQUIRED_STEP_OUTPUTS = [
  "route",
  "tracker",
  "sprint",
  "open_issue_count",
  "open_pr_count",
  "stale_pr_count",
  "reason",
  "pending_count",
  "dispatched_count",
  "active_count",
  "current_count",
  "failed_count",
  "hold_target",
  "target_dispatched",
] as const;

describe("action I/O behavior contracts", () => {
  beforeEach(() => {
    resetGithubActionsCapture();
  });

  test("AP-IO-001: main sets every stable step output key", async () => {
    const h = makeMainHarness({
      result: makeRunResult({
        evaluation: makeEvaluation({
          route: "work",
          tracker: "9",
          sprint: 9,
          openIssueCount: 4,
          openPrCount: 2,
          stalePrCount: 1,
          reason: "because",
        }),
        prCi: makePrCi({
          pending: [{ number: 1, branch: "b", sha: "s", url: "u" }],
          dispatched: [
            { number: 2, branch: "b", sha: "s", url: "u" },
            { number: 3, branch: "b", sha: "s", url: "u" },
          ],
          active: [{ number: 4, branch: "b", sha: "s", url: "u" }],
          current: [],
          failed: [{ number: 5, branch: "b", sha: "s", url: "u" }],
        }),
        decision: makeDecision({
          holdTarget: true,
          targetDispatched: "skipped",
        }),
        summary: "## summary",
      }),
    });

    await main(h.deps);

    for (const key of REQUIRED_STEP_OUTPUTS) {
      expect(coreCapture.outputs).toHaveProperty(key);
    }
  });

  test("AP-IO-002: default inputs when omitted match stable contract", async () => {
    const h = makeMainHarness();
    await main(h.deps);
    const cfg = h.runCalls[0].config;

    expect(cfg.carettaVersion).toBe("latest");
    expect(cfg.agent).toBe("claude");
    expect(cfg.context).toBe(
      "Autopilot scheduled evaluation of open issues and pull requests.",
    );
    expect(cfg.ciWorkflow).toBe("ci.yml");
    expect(cfg.gitUserName).toBe("caretta-autopilot[bot]");
    expect(cfg.gitUserEmail).toBe(
      "caretta-autopilot[bot]@users.noreply.github.com",
    );
    expect(cfg.enableDispatch).toBe(true);
  });

  test("AP-IO-002: empty enable-dispatch input preserves default-true sentinel", async () => {
    coreCapture.inputs["enable-dispatch"] = "";
    const h = makeMainHarness();
    await main(h.deps);
    expect(h.runCalls[0].config.enableDispatch).toBe(true);
  });
});
