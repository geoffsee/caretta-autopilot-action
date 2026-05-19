import { describe, expect, mock, test } from "bun:test";
import {
  dispatchOrRerunCi,
  reconcileGateCommitStatus,
} from "../src/application/ci-dispatch-core.js";
import { FakeGitHub, makeConfig, makePR } from "./fakes.js";

mock.module("@actions/core", () => ({
  info: mock(() => {}),
  warning: mock(() => {}),
}));

describe("reconcileGateCommitStatus", () => {
  test("writes success commit status when check passed but gate status is stale pending", async () => {
    const pr = makePR({ number: 1, headRefOid: "sha-1" });
    const latestCheck = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "t",
      createdAt: "t",
    };
    const gh = new FakeGitHub({
      initialCommitStatuses: [
        {
          sha: "sha-1",
          state: "pending",
          context: "Test",
          description: "stale",
        },
      ],
    });

    await reconcileGateCommitStatus(
      gh,
      makeConfig({ testCheckName: "Test" }),
      pr,
      latestCheck,
      "pfx",
    );

    const last = gh.createdStatuses[gh.createdStatuses.length - 1];
    expect(last).toEqual(
      expect.objectContaining({
        sha: "sha-1",
        state: "success",
        context: "Test",
      }),
    );
  });

  test("warns when commit status reconcile fails", async () => {
    const core = await import("@actions/core");
    const warn = core.warning as ReturnType<typeof mock>;
    warn.mockReset();

    const pr = makePR({ number: 1, headRefOid: "sha-1" });
    const latestCheck = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "t",
      createdAt: "t",
    };
    const gh = new FakeGitHub({
      initialCommitStatuses: [
        {
          sha: "sha-1",
          state: "pending",
          context: "Test",
          description: "stale",
        },
      ],
      createCommitStatusFailTimes: 1,
    });

    await reconcileGateCommitStatus(
      gh,
      makeConfig({ testCheckName: "Test" }),
      pr,
      latestCheck,
      "pfx",
    );

    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "failed to reconcile commit status",
    );
  });
});

describe("dispatchOrRerunCi", () => {
  test("reruns failed jobs when failedRun is present", async () => {
    const pr = makePR({ number: 2, headRefName: "agent/issue-2" });
    const gh = new FakeGitHub({});
    const failedRun = {
      id: 900,
      headSha: pr.headRefOid,
      status: "completed",
      conclusion: "failure" as string | null,
    };

    const ok = await dispatchOrRerunCi(gh, makeConfig(), pr, failedRun, "pfx");

    expect(ok).toBe(true);
    expect(gh.reRunCalls).toEqual([900]);
    expect(
      gh.createdStatuses.some(
        (s) => s.state === "pending" && s.description.includes("rerunning"),
      ),
    ).toBe(true);
  });

  test("on dispatch failure, sets error status and warns", async () => {
    const core = await import("@actions/core");
    const warn = core.warning as ReturnType<typeof mock>;
    warn.mockReset();

    const pr = makePR({ number: 3, headRefName: "b3" });
    const gh = new FakeGitHub({
      dispatchShouldFail: () => true,
    });

    const ok = await dispatchOrRerunCi(gh, makeConfig(), pr, undefined, "pfx");

    expect(ok).toBe(false);
    expect(
      gh.createdStatuses.some(
        (s) => s.state === "error" && s.description.includes("dispatch failed"),
      ),
    ).toBe(true);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("operation failed")),
    ).toBe(true);
  });

  test("warns when error commit status cannot be written after failure", async () => {
    const core = await import("@actions/core");
    const warn = core.warning as ReturnType<typeof mock>;
    warn.mockReset();

    const pr = makePR({ number: 4, headRefName: "b4" });
    const gh = new FakeGitHub({
      dispatchShouldFail: () => true,
      createCommitStatusFailTimes: 1,
    });

    const ok = await dispatchOrRerunCi(gh, makeConfig(), pr, undefined, "pfx");

    expect(ok).toBe(false);
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("failed to set error status"),
      ),
    ).toBe(true);
  });
});
