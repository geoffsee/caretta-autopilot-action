import { describe, expect, test } from "bun:test";
import { filterAgentPRs, processAgentPRs } from "../src/pr-ci.js";
import { FakeGitHub, makeConfig, makePR } from "./fakes.js";
import { DEFAULT_AGENT_BRANCH } from "../src/types.js";

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
  test("classifies a PR with an existing Test check as current and skips dispatch", async () => {
    const gh = new FakeGitHub({
      checksBySha: {
        "sha-1": [{ name: "Test", startedAt: null, createdAt: "2026-01-01T00:00:00Z" }],
      },
    });
    const result = await processAgentPRs(gh, [makePR({ number: 1 })], makeConfig());
    expect(result.current).toHaveLength(1);
    expect(result.pending).toHaveLength(0);
    expect(gh.dispatched).toHaveLength(0);
  });

  test("classifies a PR with an in-progress CI run as active and skips dispatch", async () => {
    const gh = new FakeGitHub({
      runsByKey: {
        "ci.yml|in_progress|agent/issue-2": [{ id: 99, headSha: "sha-2", status: "in_progress" }],
      },
    });
    const result = await processAgentPRs(gh, [makePR({ number: 2 })], makeConfig());
    expect(result.active).toHaveLength(1);
    expect(result.pending).toHaveLength(1);
    expect(gh.dispatched).toHaveLength(0);
  });

  test("dispatches CI for a pending PR with no existing run", async () => {
    const gh = new FakeGitHub();
    const result = await processAgentPRs(gh, [makePR({ number: 3 })], makeConfig());
    expect(result.dispatched).toHaveLength(1);
    expect(result.pending).toHaveLength(1);
    expect(gh.dispatched).toEqual([
      { workflow: "ci.yml", ref: "agent/issue-3", inputs: undefined },
    ]);
  });

  test("records a failed dispatch without retrying", async () => {
    const gh = new FakeGitHub({ dispatchShouldFail: () => true });
    const result = await processAgentPRs(gh, [makePR({ number: 4 })], makeConfig());
    expect(result.failed).toHaveLength(1);
    expect(result.dispatched).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
  });

  test("dry-run does not call dispatch but still classifies as pending", async () => {
    const gh = new FakeGitHub();
    const result = await processAgentPRs(
      gh,
      [makePR({ number: 5 })],
      makeConfig({ dryRun: true }),
    );
    expect(result.pending).toHaveLength(1);
    expect(result.dispatched).toHaveLength(0);
    expect(gh.dispatched).toHaveLength(0);
  });

  test("ignores runs whose head SHA differs from the PR head SHA", async () => {
    const gh = new FakeGitHub({
      runsByKey: {
        "ci.yml|queued|agent/issue-6": [
          { id: 1, headSha: "stale-sha", status: "queued" },
        ],
      },
    });
    const result = await processAgentPRs(gh, [makePR({ number: 6 })], makeConfig());
    expect(result.active).toHaveLength(0);
    expect(result.dispatched).toHaveLength(1);
  });
});
