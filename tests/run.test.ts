import { describe, expect, test, mock, beforeEach } from "bun:test";
import { runAutopilot } from "../src/run.js";
import {
  FakeGitHub,
  FakeExec,
  makeConfig,
  makeIssue,
  makePR,
} from "./fakes.js";

// Mock install.ts
mock.module("../src/install.js", () => ({
  installCaretta: async () => ({
    binaryPath: "/mock/caretta",
    version: "v1.2.3",
  }),
  installLinuxRuntimeDeps: async () => {},
  materializeBotPrivateKey: () => {},
}));

describe("runAutopilot", () => {
  let exec: FakeExec;

  beforeEach(() => {
    exec = new FakeExec();
  });

  test("tracker path: sprint + idle PRs → dispatch CI per PR then tracker workflow", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101 }), makePR({ number: 102 })],
    });
    const result = await runAutopilot(gh, exec, makeConfig(), "master");

    expect(result.evaluation.workflow).toBe("tracker-loop-dispatch.yml");
    expect(result.evaluation.tracker).toBe("50");
    expect(result.prCi.dispatched).toHaveLength(2);
    expect(result.decision.holdTarget).toBe(true);
    expect(result.decision.targetDispatched).toBe("skipped");
    const ciDispatches = gh.dispatched.filter((d) => d.workflow === "ci.yml");
    expect(ciDispatches).toHaveLength(2);
    const targetDispatches = gh.dispatched.filter(
      (d) => d.workflow === "tracker-loop-dispatch.yml",
    );
    expect(targetDispatches).toHaveLength(0);
  });

  test("factory path: no sprint, no PRs → dispatch factory immediately", async () => {
    const gh = new FakeGitHub();
    const result = await runAutopilot(gh, exec, makeConfig(), "master");

    expect(result.evaluation.workflow).toBe("factory-cycle-dispatch.yml");
    expect(result.decision.holdTarget).toBe(false);
    expect(result.decision.targetDispatched).toBe("factory");
    expect(gh.dispatched).toEqual([
      {
        workflow: "factory-cycle-dispatch.yml",
        ref: "master",
        inputs: { context: "test context" },
      },
    ]);
  });

  test("busy target: PR-CI is skipped entirely", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101 })],
      runsByKey: {
        "tracker-loop-dispatch.yml|in_progress|": [
          { id: 1, headSha: "x", status: "in_progress" },
        ],
      },
    });
    const result = await runAutopilot(gh, exec, makeConfig(), "master");
    expect(result.decision.targetBusy).toBe(true);
    expect(result.prCi.pending).toHaveLength(0);
    expect(gh.dispatched).toHaveLength(0);
  });

  test("dry-run with pending PRs: holds target, does not call any dispatch", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101 })],
    });
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig({ dryRun: true }),
      "master",
    );
    expect(result.decision.holdTarget).toBe(true);
    expect(result.decision.targetDispatched).toBe("skipped");
    expect(gh.dispatched).toHaveLength(0);
  });

  test("enable-dispatch=false: evaluates and classifies, but calls no dispatch", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101 }), makePR({ number: 102 })],
    });
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig({ enableDispatch: false }),
      "master",
    );

    expect(result.evaluation.workflow).toBe("tracker-loop-dispatch.yml");
    expect(result.evaluation.tracker).toBe("50");
    expect(result.prCi.pending).toHaveLength(2);
    expect(result.prCi.dispatched).toHaveLength(0);
    expect(result.decision.targetDispatched).toBe("skipped");
    expect(gh.dispatched).toHaveLength(0);
  });

  test("PR with Test check is current → no CI dispatch, tracker still dispatches", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101 })],
      checksBySha: {
        "sha-101": [
          { name: "Test", startedAt: "2026-01-01T00:00:00Z", createdAt: null },
        ],
      },
    });
    const result = await runAutopilot(gh, exec, makeConfig(), "master");
    expect(result.prCi.current).toHaveLength(1);
    expect(result.prCi.dispatched).toHaveLength(0);
    expect(result.decision.holdTarget).toBe(false);
    expect(result.decision.targetDispatched).toBe("tracker");
  });

  test("execute mode: runs tracker loop inline", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101, headRefName: "agent/issue-101" })],
      checksBySha: {
        "sha-101": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
    });
    // Mock tracker-matrix output
    exec.stdout = JSON.stringify([101]);

    const result = await runAutopilot(
      gh,
      exec,
      makeConfig({ mode: "execute" }),
      "master",
    );

    expect(result.decision.targetDispatched).toBe("executed");

    // Verify tracker-matrix call
    const matrixCall = exec.calls.find((c) =>
      c.args.includes("tracker-matrix"),
    );
    expect(matrixCall).toBeDefined();
    expect(matrixCall?.args).toContain("50");

    // Verify issue calls
    const issueCalls = exec.calls.filter((c) => c.args.includes("issue"));
    expect(issueCalls).toHaveLength(1);
    expect(issueCalls[0].args).toContain("101");

    // Verify code-review and fix-pr
    expect(
      exec.calls.some(
        (c) => c.args.includes("code-review") && c.args.includes("101"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) => c.args.includes("fix-pr") && c.args.includes("101"),
      ),
    ).toBe(true);

    // Verify other tracker loop calls
    expect(
      exec.calls.some(
        (c) =>
          c.args.includes("auto-merge") && c.args.includes("--sync-branches"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) =>
          c.args.includes("auto-merge") && c.args.includes("--automerge-queue"),
      ),
    ).toBe(true);
  });

  test("execute mode: runs factory cycle inline", async () => {
    const gh = new FakeGitHub();
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig({ mode: "execute" }),
      "master",
    );

    expect(result.decision.targetDispatched).toBe("executed");
    expect(exec.calls.some((c) => c.args.includes("housekeeping"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("ideation"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("report-research"))).toBe(
      true,
    );
    expect(exec.calls.some((c) => c.args.includes("strategic-review"))).toBe(
      true,
    );
    expect(exec.calls.some((c) => c.args.includes("sprint-planning"))).toBe(
      true,
    );
  });
});
