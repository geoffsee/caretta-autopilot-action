import { describe, expect, test } from "bun:test";
import type { PrCiResult } from "../packages/action-common/src/types.js";
import { computeHoldTarget, decideExecution } from "../src/domain/decide.js";
import { makeConfig } from "./fakes.js";

const emptyPrCi: PrCiResult = {
  pending: [],
  dispatched: [],
  active: [],
  current: [],
  failed: [],
};

describe("computeHoldTarget", () => {
  test.each([
    {
      name: "holds when any PR was dispatched",
      prCi: {
        ...emptyPrCi,
        dispatched: [{ number: 1, branch: "b", sha: "s", url: "u" }],
      },
      dryRun: false,
      expected: true,
    },
    {
      name: "holds when any PR is active",
      prCi: {
        ...emptyPrCi,
        active: [{ number: 1, branch: "b", sha: "s", url: "u" }],
      },
      dryRun: false,
      expected: true,
    },
    {
      name: "holds in dry-run when there is pending work",
      prCi: {
        ...emptyPrCi,
        pending: [{ number: 1, branch: "b", sha: "s", url: "u" }],
      },
      dryRun: true,
      expected: true,
    },
    {
      name: "does not hold when nothing is pending and not dry-run",
      prCi: emptyPrCi,
      dryRun: false,
      expected: false,
    },
    {
      name: "does not hold when dry-run but no pending work",
      prCi: emptyPrCi,
      dryRun: true,
      expected: false,
    },
  ])("$name", ({ prCi, dryRun, expected }) => {
    expect(computeHoldTarget(prCi, dryRun)).toBe(expected);
  });
});

describe("decideExecution", () => {
  test("executes when nothing pending and not dry-run", () => {
    expect(decideExecution(emptyPrCi, makeConfig())).toEqual({
      holdTarget: false,
      targetDispatched: "executed",
    });
  });

  test("skips when dry-run", () => {
    expect(decideExecution(emptyPrCi, makeConfig({ dryRun: true }))).toEqual({
      holdTarget: false,
      targetDispatched: "skipped",
    });
  });

  test("skips when enable-dispatch is false", () => {
    expect(
      decideExecution(emptyPrCi, makeConfig({ enableDispatch: false })),
    ).toEqual({ holdTarget: false, targetDispatched: "skipped" });
  });

  test("skips and holds when PR-CI activity is in flight", () => {
    const decision = decideExecution(
      {
        ...emptyPrCi,
        active: [{ number: 1, branch: "b", sha: "s", url: "u" }],
      },
      makeConfig(),
    );
    expect(decision.holdTarget).toBe(true);
    expect(decision.targetDispatched).toBe("skipped");
  });
});
