import { beforeEach, describe, expect, test } from "bun:test";
import { type ExecuteDeps, executeAutopilot } from "../src/execute.js";
import type { EvaluationResult } from "../src/types.js";
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
  conflictResolverOptions: {
    intervalMs: 0,
    timeoutMs: 60_000,
    maxAttemptsPerPr: 1,
  },
};

const workEval: EvaluationResult = {
  route: "work",
  sprint: 7,
  openIssueCount: 0,
  openPrCount: 0,
  stalePrCount: 0,
  tracker: "7",
  reason: "",
  activeSprint: "#7",
};

const factoryEval: EvaluationResult = {
  ...workEval,
  route: "factory",
  sprint: null,
  tracker: "",
  activeSprint: "none",
};

const unknownEval = {
  ...workEval,
  route: "other" as unknown as EvaluationResult["route"],
  tracker: "",
};

describe("executeAutopilot", () => {
  let exec: FakeExec;

  beforeEach(() => {
    exec = new FakeExec();
  });

  test("no-op when route matches neither work nor factory", async () => {
    const gh = new FakeGitHub();
    await executeAutopilot(
      gh,
      exec,
      makeConfig(),
      unknownEval,
      fakeInstallDeps,
    );
    expect(exec.calls).toHaveLength(0);
    expect(gh.dispatched).toHaveLength(0);
  });

  test("configures git identity and propagates it to caretta subprocess env", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
    });
    const identityCalls: Array<{ name: string; email: string }> = [];
    await executeAutopilot(
      gh,
      exec,
      makeConfig({
        gitUserName: "bot-name",
        gitUserEmail: "bot@example.com",
      }),
      factoryEval,
      {
        ...fakeInstallDeps,
        configureGitIdentity: async (name, email) => {
          identityCalls.push({ name, email });
        },
      },
    );

    expect(identityCalls).toEqual([
      { name: "bot-name", email: "bot@example.com" },
    ]);

    const housekeeping = exec.calls.find((c) =>
      c.args.includes("housekeeping"),
    );
    expect(housekeeping?.options?.env?.GIT_AUTHOR_NAME).toBe("bot-name");
    expect(housekeeping?.options?.env?.GIT_AUTHOR_EMAIL).toBe(
      "bot@example.com",
    );
    expect(housekeeping?.options?.env?.GIT_COMMITTER_NAME).toBe("bot-name");
    expect(housekeeping?.options?.env?.GIT_COMMITTER_EMAIL).toBe(
      "bot@example.com",
    );
  });

  test("propagates github-token to caretta subprocess env as GH_TOKEN", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
    });
    await executeAutopilot(
      gh,
      exec,
      makeConfig({ githubToken: "resolved-input-token" }),
      factoryEval,
      fakeInstallDeps,
    );
    const housekeeping = exec.calls.find((c) =>
      c.args.includes("housekeeping"),
    );
    expect(housekeeping?.args[0]).toBe("--auto");
    expect(housekeeping?.options?.env?.GH_TOKEN).toBe("resolved-input-token");
    expect(housekeeping?.options?.env?.GITHUB_TOKEN).toBe(
      "resolved-input-token",
    );
  });

  test("factory cycle skips ideation when an open 'sprint' issue exists", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
    });
    await executeAutopilot(
      gh,
      exec,
      makeConfig(),
      factoryEval,
      fakeInstallDeps,
    );

    expect(exec.calls.some((c) => c.args.includes("housekeeping"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("ideation"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("report-research"))).toBe(
      false,
    );
    expect(exec.calls.some((c) => c.args.includes("strategic-review"))).toBe(
      false,
    );
    expect(exec.calls.some((c) => c.args.includes("sprint-planning"))).toBe(
      false,
    );
  });

  test("work dispatch runs fix-conflicts on DIRTY agent-branch PRs", async () => {
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

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    const fixCalls = exec.calls.filter((c) => c.args.includes("fix-conflicts"));
    expect(fixCalls.length).toBeGreaterThanOrEqual(1);
    expect(fixCalls[0].args).toContain("201");
    // DIRTY PR must not reach code-review / fix-pr
    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(false);
  });

  test("work dispatch skips code-review/fix-pr when CI is not successful", async () => {
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

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

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

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    // Empty matrix → no per-issue caretta call
    expect(
      exec.calls.some(
        (c) => c.args.includes("issue") && c.args.includes("--tracker"),
      ),
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
