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

  test("work dispatch fires CI after automerge-queue advances the branch tip", async () => {
    const pr = makePR({
      number: 501,
      headRefName: "agent/issue-501",
      headRefOid: "sha-501-original",
    });
    const passingTest = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "2026-01-01T00:00:00Z",
      createdAt: null,
    };
    const gh = new FakeGitHub({
      prs: [pr],
      checksBySha: {
        "sha-501-original": [passingTest],
        // sha-501-advanced intentionally has no Test check — emulates the
        // post-update-branch state that auto-merge then waits on forever.
      },
    });
    exec.stdout = JSON.stringify([501]);

    // Simulate caretta's `auto-merge --automerge-queue` advancing the PR tip
    // via `gh pr update-branch`.
    const origExec = exec.exec.bind(exec);
    exec.exec = async (cmd, args, opts) => {
      const ret = await origExec(cmd, args, opts);
      if (args?.includes("auto-merge") && args.includes("--automerge-queue")) {
        (pr as { headRefOid: string }).headRefOid = "sha-501-advanced";
      }
      return ret;
    };

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    const dispatches = gh.dispatched.filter(
      (d) => d.ref === "agent/issue-501" && d.workflow === "ci.yml",
    );
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    // The dispatch must happen after caretta enters --automerge-queue (which
    // is the only thing in this test that mutates the tip to a check-less SHA).
    const automergeQueueIdx = exec.calls.findIndex(
      (c) =>
        c.args.includes("auto-merge") && c.args.includes("--automerge-queue"),
    );
    expect(automergeQueueIdx).toBeGreaterThanOrEqual(0);
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

  // The BLOCKED-on-self-approval bug observed in production was caused by
  // 57d185e, which made the action mint a GitHub App installation token from
  // DEV_BOT_* creds and use it as ambient GH_TOKEN/GITHUB_TOKEN. Caretta's
  // review path independently mints from the same DEV_BOT_* creds, so both
  // `gh pr create` and `gh pr review` ran under the same `caretta-ai[bot]`
  // identity — GitHub does not count self-approvals.
  //
  // The 57d185e change was added on the theory that PRs created under
  // GITHUB_TOKEN don't trigger CI events and therefore can't satisfy the
  // required-check rollup. Empirically that theory is wrong for this repo:
  // pre-57d185e merged PRs (#50, #51, #53, #54, #97) all show a Test check
  // produced by `event: workflow_dispatch` (dispatchMissingCi in this action)
  // that *did* satisfy the rollup. So the App-mint detour was unnecessary;
  // reverting it restores two distinct identities (`github-actions[bot]`
  // creates, `caretta-ai[bot]` reviews) and PRs merge again.
  //
  // This test pins down the post-revert invariant: regardless of whether
  // DEV_BOT_* App creds are in the env, the caretta subprocess sees the
  // workflow's GITHUB_TOKEN as its ambient GH_TOKEN — not a minted App token.
  test("propagates the workflow GITHUB_TOKEN to the caretta subprocess, ignoring DEV_BOT_* App creds for ambient auth", async () => {
    const previousEnv = { ...process.env };
    process.env.DEV_BOT_APP_ID = "12345";
    process.env.DEV_BOT_PRIVATE_KEY = "/tmp/dev-bot.pem";
    process.env.DEV_BOT_INSTALLATION_ID = "99999";

    try {
      const gh = new FakeGitHub({
        issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
      });
      await executeAutopilot(
        gh,
        exec,
        makeConfig({ githubToken: "ghs_workflow_default" }),
        factoryEval,
        fakeInstallDeps,
      );

      const carettaCalls = exec.calls.filter(
        (c) => c.command === "/mock/caretta",
      );
      expect(carettaCalls.length).toBeGreaterThan(0);
      for (const call of carettaCalls) {
        const callEnv = (call.options?.env ?? {}) as Record<string, string>;
        expect(callEnv.GH_TOKEN).toBe("ghs_workflow_default");
        expect(callEnv.GITHUB_TOKEN).toBe("ghs_workflow_default");
      }
    } finally {
      process.env = previousEnv;
    }
  });
});
