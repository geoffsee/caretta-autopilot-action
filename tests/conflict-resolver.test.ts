import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "@caretta/action-common/github-client";
import type { PullRequest } from "@caretta/action-common/types";
import {
  ConflictResolver,
  type ConflictResolverDeps,
} from "../src/application/conflict-resolver.js";
import { FakeExec, FakeGitHub, makeConfig, makePR } from "./fakes.js";

interface Harness {
  readonly gh: GitHubClient;
  readonly snapshots: PullRequest[][];
  setSnapshot(idx: number): void;
}

/** Returns a GitHubClient whose listOpenPullRequests advances through snapshots. */
function harness(snapshots: PullRequest[][]): Harness {
  let cursor = 0;
  const gh: GitHubClient = {
    listOpenIssues: async () => [],
    listOpenPullRequests: async () => {
      const snap = snapshots[Math.min(cursor, snapshots.length - 1)] ?? [];
      cursor = Math.min(cursor + 1, snapshots.length - 1);
      return [...snap];
    },
    listRecentlyMergedPullRequests: async () => [],
    getDefaultBranch: async () => "main",
    getIssueBody: async () => "",
    updateIssueBody: async () => {},
    closeIssueWithComment: async () => {},
    listWorkflowRuns: async () => [],
    listCheckRuns: async () => [],
    getLatestCommitStatus: async () => null,
    listReviews: async () => [],
    dispatchWorkflow: async () => {},
    reRunWorkflowFailedJobs: async () => {},
    createCommitStatus: async () => {},
    enableAutoMerge: async () => {},
    mergePullRequest: async (
      _prNumber: number,
      _method: "SQUASH" | "MERGE" | "REBASE",
      _expectedHeadOid: string,
    ) => {},
    retargetPullRequest: async () => {},
  };
  return {
    gh,
    snapshots,
    setSnapshot(idx) {
      cursor = idx;
    },
  };
}

function fakeDeps(fix: (pr: number) => Promise<void>) {
  let nowValue = 0;
  return {
    now: () => nowValue,
    sleep: async (ms: number) => {
      nowValue += ms;
    },
    fixConflicts: fix,
    advance: (ms: number) => {
      nowValue += ms;
    },
  };
}

describe("ConflictResolver", () => {
  test("default fixConflicts throws a configuration error when invoked", () => {
    const gh = new FakeGitHub();
    const resolver = new ConflictResolver(
      gh,
      makeConfig(),
      {},
      {
        now: () => 0,
        sleep: async () => {},
      },
    );
    const deps = (resolver as unknown as { deps: ConflictResolverDeps }).deps;
    expect(() => {
      deps.fixConflicts(42);
    }).toThrow(/no fixConflicts dependency configured/);
  });

  test("fixes a single DIRTY agent PR and reports it resolved", async () => {
    const dirty = makePR({
      number: 101,
      headRefName: "agent/issue-101",
      mergeStateStatus: "DIRTY",
    });
    const clean = { ...dirty, mergeStateStatus: "CLEAN" };
    const h = harness([[dirty], [clean]]);
    const fixedPrs: number[] = [];
    const deps = fakeDeps(async (pr) => {
      fixedPrs.push(pr);
    });

    const resolver = new ConflictResolver(h.gh, makeConfig(), {}, deps);
    const result = await resolver.resolveAll();

    expect(fixedPrs).toEqual([101]);
    expect(result.fixed).toEqual([101]);
    expect(result.unresolved).toEqual([]);
    expect(result.timedOut).toBe(false);
  });

  test("ignores non-agent and draft PRs", async () => {
    const human = makePR({
      number: 1,
      headRefName: "feature/manual",
      mergeStateStatus: "DIRTY",
    });
    const draft = makePR({
      number: 2,
      headRefName: "agent/issue-2",
      mergeStateStatus: "DIRTY",
      isDraft: true,
    });
    const h = harness([[human, draft]]);
    const fixedPrs: number[] = [];
    const deps = fakeDeps(async (pr) => {
      fixedPrs.push(pr);
    });

    const resolver = new ConflictResolver(h.gh, makeConfig(), {}, deps);
    const result = await resolver.resolveAll();

    expect(fixedPrs).toEqual([]);
    expect(result.fixed).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  test("retries up to maxAttemptsPerPr then reports unresolved", async () => {
    const dirty = makePR({
      number: 7,
      headRefName: "agent/issue-7",
      mergeStateStatus: "DIRTY",
    });
    const h = harness([[dirty]]);
    let calls = 0;
    const deps = fakeDeps(async () => {
      calls += 1;
    });

    const resolver = new ConflictResolver(
      h.gh,
      makeConfig(),
      { maxAttemptsPerPr: 3, intervalMs: 1, timeoutMs: 1_000_000 },
      deps,
    );
    const result = await resolver.resolveAll();

    expect(calls).toBe(3);
    expect(result.unresolved).toEqual([7]);
    expect(result.timedOut).toBe(false);
  });

  test("times out once total elapsed exceeds timeoutMs", async () => {
    const dirty = makePR({
      number: 9,
      headRefName: "agent/issue-9",
      mergeStateStatus: "DIRTY",
    });
    const h = harness([[dirty]]);
    const deps = fakeDeps(async () => {});

    const resolver = new ConflictResolver(
      h.gh,
      makeConfig(),
      { maxAttemptsPerPr: 100, intervalMs: 500, timeoutMs: 1_000 },
      deps,
    );
    const result = await resolver.resolveAll();

    expect(result.timedOut).toBe(true);
    expect(result.unresolved).toEqual([9]);
  });

  test("scope filter restricts to listed PR numbers", async () => {
    const a = makePR({
      number: 11,
      headRefName: "agent/issue-11",
      mergeStateStatus: "DIRTY",
    });
    const b = makePR({
      number: 22,
      headRefName: "agent/issue-22",
      mergeStateStatus: "DIRTY",
    });
    const h = harness([[a, b]]);
    const fixedPrs: number[] = [];
    const deps = fakeDeps(async (pr) => {
      fixedPrs.push(pr);
    });

    const resolver = new ConflictResolver(
      h.gh,
      makeConfig(),
      { prNumbers: [22], maxAttemptsPerPr: 1 },
      deps,
    );
    await resolver.resolveAll();

    expect(fixedPrs).toEqual([22]);
  });

  test("a fixConflicts throw counts toward attempt cap but is non-fatal", async () => {
    const dirty = makePR({
      number: 33,
      headRefName: "agent/issue-33",
      mergeStateStatus: "DIRTY",
    });
    const h = harness([[dirty]]);
    let calls = 0;
    const deps = fakeDeps(async () => {
      calls += 1;
      throw new Error("boom");
    });

    const resolver = new ConflictResolver(
      h.gh,
      makeConfig(),
      { maxAttemptsPerPr: 2, intervalMs: 1, timeoutMs: 1_000_000 },
      deps,
    );
    const result = await resolver.resolveAll();

    expect(calls).toBe(2);
    expect(result.fixed).toEqual([]);
    expect(result.unresolved).toEqual([33]);
  });

  test("withCaretta wires exec to fix-conflicts with the configured agent", async () => {
    const dirty = makePR({
      number: 55,
      headRefName: "agent/issue-55",
      mergeStateStatus: "DIRTY",
    });
    const gh = new FakeGitHub({ prs: [dirty] });
    const exec = new FakeExec();
    const env = { FOO: "bar" };

    const resolver = ConflictResolver.withCaretta(
      gh,
      makeConfig({ agent: "claude" }),
      "/mock/caretta",
      env,
      exec,
      { maxAttemptsPerPr: 1, intervalMs: 1, timeoutMs: 1_000_000 },
    );
    await resolver.resolveAll();

    const call = exec.calls.find((c) => c.args.includes("fix-conflicts"));
    expect(call).toBeDefined();
    expect(call?.command).toBe("/mock/caretta");
    expect(call?.args).toEqual([
      "--auto",
      "--agent",
      "claude",
      "fix-conflicts",
      "55",
    ]);
    expect(call?.options?.env).toEqual(env);
  });
});
