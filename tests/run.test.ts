import { beforeEach, describe, expect, test } from "bun:test";
import type { ExecuteDeps } from "../src/execute.js";
import { runAutopilot } from "../src/run.js";
import {
  FakeExec,
  FakeGitHub,
  makeConfig,
  makeIssue,
  makePR,
} from "./fakes.js";

const fakeInstallDeps: ExecuteDeps = {
  installCaretta: async () => ({
    binaryPath: "/mock/caretta",
    version: "v1.2.3",
  }),
  installLinuxRuntimeDeps: async () => {},
  materializeBotPrivateKey: () => {},
  configureGitIdentity: async () => {},
  mintInstallationToken: async () => "should-not-be-called",
};

describe("runAutopilot", () => {
  let exec: FakeExec;

  beforeEach(() => {
    exec = new FakeExec();
  });

  test("work route: sprint + idle PRs → dispatch CI per PR, hold execution", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101 }), makePR({ number: 102 })],
    });
    const result = await runAutopilot(gh, exec, makeConfig(), "master");

    expect(result.evaluation.route).toBe("work");
    expect(result.evaluation.tracker).toBe("50");
    expect(result.prCi.dispatched).toHaveLength(2);
    expect(result.decision.holdTarget).toBe(true);
    expect(result.decision.targetDispatched).toBe("skipped");
    const ciDispatches = gh.dispatched.filter((d) => d.workflow === "ci.yml");
    expect(ciDispatches).toHaveLength(2);
  });

  test("factory route: no sprint, no PRs → executes inline", async () => {
    const gh = new FakeGitHub();
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig(),
      "master",
      fakeInstallDeps,
    );

    expect(result.evaluation.route).toBe("factory");
    expect(result.decision.holdTarget).toBe(false);
    expect(result.decision.targetDispatched).toBe("executed");
    const hk = exec.calls.find((c) => c.args.includes("housekeeping"));
    expect(hk?.args[0]).toBe("--auto");
    expect(exec.calls.some((c) => c.args.includes("housekeeping"))).toBe(true);
  });

  test("dry-run with pending PRs: holds, dispatches no CI, executes nothing", async () => {
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
    expect(exec.calls).toHaveLength(0);
  });

  test("enable-dispatch=false: evaluates and classifies, but executes nothing", async () => {
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

    expect(result.evaluation.route).toBe("work");
    expect(result.evaluation.tracker).toBe("50");
    expect(result.prCi.pending).toHaveLength(2);
    expect(result.prCi.dispatched).toHaveLength(0);
    expect(result.decision.targetDispatched).toBe("skipped");
    expect(gh.dispatched).toHaveLength(0);
    expect(exec.calls).toHaveLength(0);
  });

  test("PR with Test check is current → no CI dispatch, work dispatch executes", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [makePR({ number: 101 })],
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
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig(),
      "master",
      fakeInstallDeps,
    );
    expect(result.prCi.current).toHaveLength(1);
    expect(result.prCi.dispatched).toHaveLength(0);
    expect(result.decision.holdTarget).toBe(false);
    expect(result.decision.targetDispatched).toBe("executed");
  });

  test("work route: runs work dispatch inline", async () => {
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
    exec.stdout = JSON.stringify([101]);

    const result = await runAutopilot(
      gh,
      exec,
      makeConfig(),
      "master",
      fakeInstallDeps,
    );

    expect(result.decision.targetDispatched).toBe("executed");

    const matrixCall = exec.calls.find((c) =>
      c.args.includes("tracker-matrix"),
    );
    expect(matrixCall).toBeDefined();
    expect(matrixCall?.args.slice(0, 2)).toEqual(["--auto", "--agent"]);
    expect(matrixCall?.args).toContain("50");

    const issueCalls = exec.calls.filter((c) => c.args.includes("issue"));
    expect(issueCalls).toHaveLength(1);
    expect(issueCalls[0].args).toContain("101");

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

  test("factory route: runs factory cycle inline", async () => {
    const gh = new FakeGitHub();
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig(),
      "master",
      fakeInstallDeps,
    );

    expect(result.decision.targetDispatched).toBe("executed");
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
