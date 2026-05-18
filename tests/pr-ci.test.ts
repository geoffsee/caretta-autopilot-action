import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_BRANCH } from "../packages/action-common/src/types.js";
import { filterAgentPRs, processAgentPRs } from "../src/application/pr-ci.js";
import { FakeGitHub, makeConfig, makePR } from "./fakes.js";

describe("filterAgentPRs", () => {
  test("keeps non-draft, non-DIRTY agent PRs only", () => {
    const prs = [
      makePR({ number: 1 }),
      makePR({ number: 2, isDraft: true }),
      makePR({ number: 3, mergeStateStatus: "DIRTY" }),
      makePR({ number: 4, headRefName: "feature/non-agent" }),
      makePR({ number: 5, headRefName: "agent/issue-abc" }),
    ];
    const result = filterAgentPRs(prs, DEFAULT_AGENT_BRANCH);
    expect(result.map((p) => p.number)).toEqual([1]);
  });
});

describe("processAgentPRs", () => {
  test.each([
    {
      name: "classifies CI / Test check run as current when gate is Test",
      setup: {
        checksBySha: {
          "sha-1c": [
            {
              name: "CI / Test",
              status: "completed" as const,
              conclusion: "success" as const,
              startedAt: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
      prs: [makePR({ number: 11, headRefOid: "sha-1c" })],
      config: makeConfig(),
      expected: { current: 1, pending: 0, dispatched: 0, ghDispatched: 0 },
    },
    {
      name: "classifies a PR with an existing Test check as current and skips dispatch",
      setup: {
        checksBySha: {
          "sha-1": [
            {
              name: "Test",
              status: "completed" as const,
              conclusion: "success" as const,
              startedAt: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
      prs: [makePR({ number: 1 })],
      config: makeConfig(),
      expected: { current: 1, pending: 0, dispatched: 0, ghDispatched: 0 },
    },
    {
      name: "classifies a PR with an in-progress Test check as active and skips dispatch",
      setup: {
        checksBySha: {
          "sha-2b": [
            {
              name: "Test",
              status: "in_progress" as const,
              conclusion: null,
              startedAt: "2026-01-01T00:00:00Z",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
      prs: [makePR({ number: 2, headRefOid: "sha-2b" })],
      config: makeConfig(),
      expected: { active: 1, pending: 1, dispatched: 0, ghDispatched: 0 },
    },
    {
      name: "classifies a PR with an in-progress CI run as active and skips dispatch",
      setup: {
        runsByKey: {
          "ci.yml|any|agent/issue-2": [
            {
              id: 99,
              headSha: "sha-2",
              status: "in_progress",
              conclusion: null,
            },
          ],
        },
      },
      prs: [makePR({ number: 2 })],
      config: makeConfig(),
      expected: { active: 1, pending: 1, dispatched: 0, ghDispatched: 0 },
    },
    {
      name: "dispatches CI for a pending PR with no existing run",
      setup: {},
      prs: [makePR({ number: 3 })],
      config: makeConfig(),
      expected: { active: 0, pending: 1, dispatched: 1, ghDispatched: 1 },
    },
    {
      name: "records a failed dispatch without retrying",
      setup: { dispatchShouldFail: () => true },
      prs: [makePR({ number: 4 })],
      config: makeConfig(),
      expected: { failed: 1, dispatched: 0, pending: 1, ghDispatched: 0 },
    },
    {
      name: "dry-run does not call dispatch but still classifies as pending",
      setup: {},
      prs: [makePR({ number: 5 })],
      config: makeConfig({ dryRun: true }),
      expected: { active: 0, pending: 1, dispatched: 0, ghDispatched: 0 },
    },
    {
      name: "ignores runs whose head SHA differs from the PR head SHA",
      setup: {
        runsByKey: {
          "ci.yml|any|agent/issue-6": [
            { id: 1, headSha: "stale-sha", status: "queued", conclusion: null },
          ],
        },
      },
      prs: [makePR({ number: 6 })],
      config: makeConfig(),
      expected: { active: 0, dispatched: 1, ghDispatched: 1 },
    },
  ])("$name", async ({ setup, prs, config, expected }) => {
    const gh = new FakeGitHub(setup);
    const result = await processAgentPRs(gh, prs, config);

    if (expected.current !== undefined)
      expect(result.current).toHaveLength(expected.current);
    if (expected.pending !== undefined)
      expect(result.pending).toHaveLength(expected.pending);
    if (expected.active !== undefined)
      expect(result.active).toHaveLength(expected.active);
    if (expected.dispatched !== undefined)
      expect(result.dispatched).toHaveLength(expected.dispatched);
    if (expected.failed !== undefined)
      expect(result.failed).toHaveLength(expected.failed);

    expect(gh.dispatched).toHaveLength(expected.ghDispatched);
  });

  test("creates pending status after successful dispatch", async () => {
    const gh = new FakeGitHub();
    const result = await processAgentPRs(
      gh,
      [makePR({ number: 7 })],
      makeConfig(),
    );

    expect(result.dispatched).toHaveLength(1);
    expect(gh.createdStatuses).toEqual([
      {
        sha: "sha-7",
        state: "pending",
        context: "Test",
        description: "Autopilot dispatching CI...",
        targetUrl: undefined,
      },
    ]);
  });

  test("does not create pending status when dispatch fails", async () => {
    const gh = new FakeGitHub({ dispatchShouldFail: () => true });
    const result = await processAgentPRs(
      gh,
      [makePR({ number: 8 })],
      makeConfig(),
    );

    expect(result.failed).toHaveLength(1);
    expect(gh.createdStatuses).toEqual([
      {
        sha: "sha-8",
        state: "error",
        context: "Test",
        description:
          "Autopilot CI dispatch failed: dispatch failed for ci.yml on agent/issue-8",
        targetUrl: undefined,
      },
    ]);
  });

  test("reconciles stale pending commit status when check_run is success", async () => {
    // Simulate the production bug: a prior dispatch wrote a "Test" commit
    // status as pending, then the workflow ran and produced a successful
    // "Test" check_run on the same SHA. Without reconciliation, the PR's
    // statusCheckRollup merges both into one "Test" context whose state stays
    // pending — blocking the merge despite the green check.
    const gh = new FakeGitHub({
      checksBySha: {
        "sha-success": [
          {
            name: "Test",
            status: "completed" as const,
            conclusion: "success" as const,
            startedAt: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    await gh.createCommitStatus(
      "sha-success",
      "pending",
      "Test",
      "Autopilot dispatching CI...",
    );

    const result = await processAgentPRs(
      gh,
      [makePR({ number: 21, headRefOid: "sha-success" })],
      makeConfig(),
    );

    expect(result.current).toHaveLength(1);
    const reconciliation = gh.createdStatuses.find(
      (s) => s.state === "success",
    );
    expect(reconciliation).toEqual({
      sha: "sha-success",
      state: "success",
      context: "Test",
      description: 'Autopilot synchronized "Test" from completed check run',
      targetUrl: undefined,
    });
  });

  test("does not re-write commit status when it already matches the check conclusion", async () => {
    const gh = new FakeGitHub({
      checksBySha: {
        "sha-already-reconciled": [
          {
            name: "Test",
            status: "completed" as const,
            conclusion: "success" as const,
            startedAt: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    await gh.createCommitStatus(
      "sha-already-reconciled",
      "success",
      "Test",
      "Previously reconciled",
    );

    const before = gh.createdStatuses.length;
    const result = await processAgentPRs(
      gh,
      [makePR({ number: 22, headRefOid: "sha-already-reconciled" })],
      makeConfig(),
    );

    expect(result.current).toHaveLength(1);
    expect(gh.createdStatuses).toHaveLength(before);
  });

  test("matches the CI / Test workflow check name when reconciling against a Test gate", async () => {
    const gh = new FakeGitHub({
      checksBySha: {
        "sha-ci-test": [
          {
            name: "CI / Test",
            status: "completed" as const,
            conclusion: "success" as const,
            startedAt: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    await gh.createCommitStatus(
      "sha-ci-test",
      "pending",
      "Test",
      "Autopilot dispatching CI...",
    );

    const result = await processAgentPRs(
      gh,
      [makePR({ number: 23, headRefOid: "sha-ci-test" })],
      makeConfig(),
    );

    expect(result.current).toHaveLength(1);
    const reconciliation = gh.createdStatuses.find(
      (s) => s.state === "success",
    );
    expect(reconciliation?.context).toBe("Test");
    expect(reconciliation?.state).toBe("success");
  });

  test("skips reconciliation in dry-run mode", async () => {
    const gh = new FakeGitHub({
      checksBySha: {
        "sha-dry": [
          {
            name: "Test",
            status: "completed" as const,
            conclusion: "success" as const,
            startedAt: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    await gh.createCommitStatus(
      "sha-dry",
      "pending",
      "Test",
      "Autopilot dispatching CI...",
    );
    const before = gh.createdStatuses.length;

    const result = await processAgentPRs(
      gh,
      [makePR({ number: 24, headRefOid: "sha-dry" })],
      makeConfig({ dryRun: true }),
    );

    expect(result.current).toHaveLength(1);
    expect(gh.createdStatuses).toHaveLength(before);
  });
});
