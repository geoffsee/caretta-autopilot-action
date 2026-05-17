/**
 * Behavior contract suite: execution gating (`decideExecution` / `computeHoldTarget`).
 */
import { describe, expect, test } from "bun:test";
import { computeHoldTarget, decideExecution } from "../../src/decide.js";
import type { PrCiResult } from "../../src/types.js";
import { makeConfig } from "../fakes.js";

function prci(overrides: Partial<PrCiResult> = {}): PrCiResult {
  return {
    pending: [],
    dispatched: [],
    active: [],
    current: [],
    failed: [],
    ...overrides,
  };
}

describe("decision behavior contracts", () => {
  test("AP-DC-001: dispatched or active PRs hold and skip execution", () => {
    expect(
      decideExecution(
        prci({ dispatched: [{ number: 1, branch: "b", sha: "s", url: "" }] }),
        makeConfig(),
      ),
    ).toEqual({ holdTarget: true, targetDispatched: "skipped" });

    expect(
      decideExecution(
        prci({ active: [{ number: 1, branch: "b", sha: "s", url: "" }] }),
        makeConfig(),
      ),
    ).toEqual({ holdTarget: true, targetDispatched: "skipped" });
  });

  test("AP-DC-002: dry-run with pending holds execution", () => {
    expect(
      computeHoldTarget(
        prci({ pending: [{ number: 1, branch: "b", sha: "s", url: "" }] }),
        true,
      ),
    ).toBe(true);
    expect(
      decideExecution(
        prci({ pending: [{ number: 1, branch: "b", sha: "s", url: "" }] }),
        makeConfig({ dryRun: true }),
      ),
    ).toEqual({ holdTarget: true, targetDispatched: "skipped" });
  });

  test("AP-DC-003: idle system with dispatch enabled executes", () => {
    expect(
      decideExecution(
        prci(),
        makeConfig({ dryRun: false, enableDispatch: true }),
      ),
    ).toEqual({ holdTarget: false, targetDispatched: "executed" });
  });
});
