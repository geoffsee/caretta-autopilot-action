import { describe, expect, test } from "bun:test";
import { computeHoldTarget, dispatchTarget } from "../src/decide.js";
import type { EvaluationResult, PrCiResult } from "../src/types.js";
import { FakeGitHub, makeConfig } from "./fakes.js";

const emptyPrCi: PrCiResult = {
  pending: [],
  dispatched: [],
  active: [],
  current: [],
  failed: [],
};

const trackerEval: EvaluationResult = {
  sprint: 7,
  openIssueCount: 0,
  openPrCount: 0,
  stalePrCount: 0,
  workflow: "tracker-loop-dispatch.yml",
  tracker: "7",
  reason: "open sprint #7 found; dispatching tracker loop",
  activeSprint: "#7",
};

const factoryEval: EvaluationResult = {
  sprint: null,
  openIssueCount: 0,
  openPrCount: 0,
  stalePrCount: 0,
  workflow: "factory-cycle-dispatch.yml",
  tracker: "",
  reason: "no open sprint found; dispatching factory cycle",
  activeSprint: "none",
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

describe("dispatchTarget", () => {
  test("dispatches tracker with tracker+context inputs", async () => {
    const gh = new FakeGitHub();
    const decision = await dispatchTarget(
      gh,
      trackerEval,
      emptyPrCi,
      makeConfig(),
      "master",
      false,
    );
    expect(decision.targetDispatched).toBe("tracker");
    expect(gh.dispatched).toHaveLength(1);
    expect(gh.dispatched[0]).toEqual({
      workflow: "tracker-loop-dispatch.yml",
      ref: "master",
      inputs: { tracker: "7", context: "test context" },
    });
  });

  test("dispatches factory with context input", async () => {
    const gh = new FakeGitHub();
    const decision = await dispatchTarget(
      gh,
      factoryEval,
      emptyPrCi,
      makeConfig(),
      "master",
      false,
    );
    expect(decision.targetDispatched).toBe("factory");
    expect(gh.dispatched[0]).toEqual({
      workflow: "factory-cycle-dispatch.yml",
      ref: "master",
      inputs: { context: "test context" },
    });
  });

  test("skips dispatch when target is busy", async () => {
    const gh = new FakeGitHub();
    const decision = await dispatchTarget(
      gh,
      trackerEval,
      emptyPrCi,
      makeConfig(),
      "master",
      true,
    );
    expect(decision.targetDispatched).toBe("skipped");
    expect(gh.dispatched).toHaveLength(0);
  });

  test("skips dispatch when hold_target is set by PR-CI activity", async () => {
    const gh = new FakeGitHub();
    const decision = await dispatchTarget(
      gh,
      trackerEval,
      {
        ...emptyPrCi,
        active: [{ number: 1, branch: "b", sha: "s", url: "u" }],
      },
      makeConfig(),
      "master",
      false,
    );
    expect(decision.holdTarget).toBe(true);
    expect(decision.targetDispatched).toBe("skipped");
    expect(gh.dispatched).toHaveLength(0);
  });

  test("skips dispatch in dry-run mode", async () => {
    const gh = new FakeGitHub();
    const decision = await dispatchTarget(
      gh,
      trackerEval,
      emptyPrCi,
      makeConfig({ dryRun: true }),
      "master",
      false,
    );
    expect(decision.targetDispatched).toBe("skipped");
    expect(gh.dispatched).toHaveLength(0);
  });

  test("execute mode skips when target is busy", async () => {
    const gh = new FakeGitHub();
    const decision = await dispatchTarget(
      gh,
      trackerEval,
      emptyPrCi,
      makeConfig({ mode: "execute" }),
      "master",
      true,
    );
    expect(decision.targetDispatched).toBe("skipped");
    expect(decision.targetBusy).toBe(true);
    expect(gh.dispatched).toHaveLength(0);
  });

  test("skips dispatch when evaluation workflow matches neither tracker nor factory", async () => {
    const gh = new FakeGitHub();
    const unknownEval: EvaluationResult = {
      ...trackerEval,
      workflow: "",
      reason: "no dispatch needed",
    };
    const decision = await dispatchTarget(
      gh,
      unknownEval,
      emptyPrCi,
      makeConfig(),
      "master",
      false,
    );
    expect(decision.targetDispatched).toBe("skipped");
    expect(gh.dispatched).toHaveLength(0);
  });
});
