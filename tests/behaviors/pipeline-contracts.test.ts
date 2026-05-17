/**
 * Behavior contract suite: end-to-end `runAutopilot` invariants (pipeline).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ExecuteDeps } from "../../src/application/execute-autopilot.js";
import { runAutopilot } from "../../src/application/run-autopilot.js";
import {
  FakeExec,
  FakeGitHub,
  makeConfig,
  makeIssue,
  makePR,
} from "../fakes.js";

const fakeInstallDeps: ExecuteDeps = {
  installCaretta: async () => ({
    binaryPath: "/mock/caretta",
    version: "v1.2.3",
  }),
  installLinuxRuntimeDeps: async () => {},
  materializeBotPrivateKey: () => {},
  configureGitIdentity: async () => {},
};

describe("pipeline behavior contracts", () => {
  let exec: FakeExec;

  beforeEach(() => {
    exec = new FakeExec();
  });

  test("AP-RN-001: factory route with executed decision runs caretta subprocess", async () => {
    const gh = new FakeGitHub();
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig(),
      "main",
      fakeInstallDeps,
    );

    expect(result.evaluation.route).toBe("factory");
    expect(result.decision.targetDispatched).toBe("executed");
    expect(exec.calls.some((c) => c.args.includes("housekeeping"))).toBe(true);
  });

  test("AP-RN-002: skipped decision performs no subprocess exec", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101 })],
    });
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig({ dryRun: true }),
      "main",
    );

    expect(result.decision.targetDispatched).toBe("skipped");
    expect(exec.calls).toHaveLength(0);
  });
});
