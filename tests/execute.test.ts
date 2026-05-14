import { describe, expect, test, mock, beforeEach } from "bun:test";
import { FakeExec, FakeGitHub, makeConfig, makeIssue, makePR } from "./fakes.js";
import type { EvaluationResult } from "../src/types.js";

mock.module("../src/install.js", () => ({
  installCaretta: async () => ({
    binaryPath: "/mock/caretta",
    version: "v1.2.3",
  }),
  installLinuxRuntimeDeps: async () => {},
  materializeBotPrivateKey: () => {},
}));

const { executeAutopilot } = await import("../src/execute.js");

const trackerEval: EvaluationResult = {
  sprint: 7,
  openIssueCount: 0,
  openPrCount: 0,
  stalePrCount: 0,
  workflow: "tracker-loop-dispatch.yml",
  tracker: "7",
  reason: "",
  activeSprint: "#7",
};

const factoryEval: EvaluationResult = {
  ...trackerEval,
  sprint: null,
  workflow: "factory-cycle-dispatch.yml",
  tracker: "",
  activeSprint: "none",
};

const unknownEval: EvaluationResult = {
  ...trackerEval,
  workflow: "other.yml",
  tracker: "",
};

describe("executeAutopilot", () => {
  let exec: FakeExec;

  beforeEach(() => {
    exec = new FakeExec();
  });

  test("no-op when workflow matches neither tracker nor factory", async () => {
    const gh = new FakeGitHub();
    await executeAutopilot(gh, exec, makeConfig({ mode: "execute" }), unknownEval);
    expect(exec.calls).toHaveLength(0);
    expect(gh.dispatched).toHaveLength(0);
  });

  test("factory cycle skips ideation when an open 'sprint' issue exists", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
    });
    await executeAutopilot(gh, exec, makeConfig({ mode: "execute" }), factoryEval);

    expect(exec.calls.some((c) => c.args.includes("housekeeping"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("ideation"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("report-research"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("strategic-review"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("sprint-planning"))).toBe(false);
  });

  test("tracker loop runs fix-conflicts on DIRTY agent-branch PRs", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 201,
          headRefName: "agent/issue-201",
          mergeStateStatus: "DIRTY",
        }),
      ],
      checksBySha: {
        "sha-201": [
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
    exec.stdout = JSON.stringify([201]);

    await executeAutopilot(gh, exec, makeConfig({ mode: "execute" }), trackerEval);

    const fixCalls = exec.calls.filter((c) =>
      c.args.includes("fix-conflicts"),
    );
    expect(fixCalls.length).toBeGreaterThanOrEqual(1);
    expect(fixCalls[0].args).toContain("201");
    // DIRTY PR must not reach code-review / fix-pr
    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(false);
  });

  test("tracker loop skips code-review/fix-pr when CI is not successful", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 301, headRefName: "agent/issue-301" })],
      checksBySha: {
        "sha-301": [
          {
            name: "Test",
            status: "completed",
            conclusion: "failure",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([301]);

    await executeAutopilot(gh, exec, makeConfig({ mode: "execute" }), trackerEval);

    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(false);
  });

  test("empty tracker-matrix: CI gate breaks early and resolveTrackerScopedPrs falls back to any agent-branch PR", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 401, headRefName: "agent/issue-401" })],
      checksBySha: {
        "sha-401": [
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
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig({ mode: "execute" }), trackerEval);

    // Empty matrix → no per-issue caretta call
    expect(
      exec.calls.some((c) => c.args.includes("issue") && c.args.includes("--tracker")),
    ).toBe(false);
    // Fallback finds the agent-branch PR with passing CI → code-review and fix-pr called
    expect(
      exec.calls.some(
        (c) => c.args.includes("code-review") && c.args.includes("401"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) => c.args.includes("fix-pr") && c.args.includes("401"),
      ),
    ).toBe(true);
  });
});
