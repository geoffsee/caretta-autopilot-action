import { describe, expect, test } from "bun:test";
import type * as actionsExec from "@actions/exec";
import type { ExecClient } from "../src/exec.js";
import type { GitHubClient } from "../src/github.js";
import {
  DEFAULT_CI_TIMEOUT_MINUTES,
  parseTimeoutMinutes,
  TrackerLoopRunner,
} from "../src/tracker-loop-runner.js";
import type {
  CheckRun,
  Issue,
  PullRequest,
  WorkflowRun,
} from "../src/types.js";

interface ExecCall {
  readonly kind: "exec" | "getExecOutput";
  readonly commandLine: string;
  readonly args: string[];
  readonly options?: actionsExec.ExecOptions;
}

class FakeExec implements ExecClient {
  readonly calls: ExecCall[] = [];

  constructor(private readonly matrixStdout: string) {}

  async exec(
    commandLine: string,
    args?: string[],
    options?: actionsExec.ExecOptions,
  ): Promise<number> {
    this.calls.push({
      kind: "exec",
      commandLine,
      args: args ?? [],
      options,
    });
    return 0;
  }

  async getExecOutput(
    commandLine: string,
    args?: string[],
    options?: actionsExec.ExecOptions,
  ): Promise<actionsExec.ExecOutput> {
    this.calls.push({
      kind: "getExecOutput",
      commandLine,
      args: args ?? [],
      options,
    });
    return {
      exitCode: 0,
      stdout: this.matrixStdout,
      stderr: "",
    };
  }
}

class FakeGitHub implements GitHubClient {
  constructor(
    private readonly prs: PullRequest[],
    private readonly checksBySha: Record<string, CheckRun[]>,
  ) {}

  async listOpenIssues(): Promise<Issue[]> {
    return [];
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    return [...this.prs];
  }

  async listWorkflowRuns(): Promise<WorkflowRun[]> {
    return [];
  }

  async listCheckRuns(sha: string): Promise<CheckRun[]> {
    return [...(this.checksBySha[sha] ?? [])];
  }

  async dispatchWorkflow(): Promise<void> {}
}

function makePR(
  number: number,
  partial: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    title: partial.title ?? `PR ${number}`,
    isDraft: partial.isDraft ?? false,
    reviewDecision: partial.reviewDecision ?? null,
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00Z",
    url: partial.url ?? `https://example/pull/${number}`,
    headRefName: partial.headRefName ?? `agent/issue-${number}`,
    headRefOid: partial.headRefOid ?? `sha-${number}`,
    mergeStateStatus: partial.mergeStateStatus ?? "CLEAN",
  };
}

function makeCheck(partial: Partial<CheckRun>): CheckRun {
  return {
    name: partial.name ?? "Test",
    status: partial.status ?? "completed",
    conclusion: partial.conclusion ?? "success",
    startedAt: partial.startedAt ?? null,
    createdAt: partial.createdAt ?? null,
  };
}

function taskFromArgs(args: string[]): string | null {
  const presetIdx = args.indexOf("software-factory");
  if (presetIdx < 0 || presetIdx + 1 >= args.length) return null;
  return args[presetIdx + 1];
}

describe("TrackerLoopRunner", () => {
  test("runs the tracker loop orchestration and only reviews PRs with passing CI", async () => {
    const gh = new FakeGitHub(
      [
        makePR(101, { headRefOid: "sha-101" }),
        makePR(102, { headRefOid: "sha-102" }),
        makePR(900, {
          headRefName: "agent/issue-900",
          headRefOid: "sha-900",
          mergeStateStatus: "DIRTY",
        }),
      ],
      {
        "sha-101": [makeCheck({ conclusion: "success" })],
        "sha-102": [makeCheck({ conclusion: "failure" })],
        "sha-900": [makeCheck({ conclusion: "success" })],
      },
    );
    const exec = new FakeExec(JSON.stringify([101, 102]));

    const runner = new TrackerLoopRunner(
      "/mock/caretta",
      { GH_TOKEN: "token" },
      exec,
      gh,
      {
        tracker: "77",
        agent: "claude",
        testCheckName: "Test",
        agentBranchPattern: /^agent\/issue-[0-9]+$/,
        ciTimeoutMs: 60_000,
      },
    );

    const result = await runner.runTrackerLoop();
    expect(result).toEqual({ issueCount: 2, reviewedPrCount: 1 });

    const matrixCalls = exec.calls.filter(
      (call) => call.kind === "getExecOutput",
    );
    expect(matrixCalls).toHaveLength(1);
    expect(taskFromArgs(matrixCalls[0].args)).toBe("tracker-matrix");

    const executedTasks = exec.calls
      .filter((call) => call.kind === "exec")
      .map((call) => taskFromArgs(call.args));

    expect(executedTasks.filter((task) => task === "issue")).toHaveLength(2);
    expect(executedTasks.filter((task) => task === "auto-merge")).toHaveLength(
      3,
    );
    expect(
      executedTasks.filter((task) => task === "fix-conflicts"),
    ).toHaveLength(2);
    expect(executedTasks.filter((task) => task === "code-review")).toHaveLength(
      1,
    );
    expect(executedTasks.filter((task) => task === "fix-pr")).toHaveLength(1);

    const reviewedPrIds = exec.calls
      .filter((call) => taskFromArgs(call.args) === "code-review")
      .map((call) => call.args.at(-1));
    expect(reviewedPrIds).toEqual(["101"]);
  });

  test("throws a parse error when tracker-matrix output is invalid", async () => {
    const runner = new TrackerLoopRunner(
      "/mock/caretta",
      { GH_TOKEN: "token" },
      new FakeExec('{"bad": true}'),
      new FakeGitHub([], {}),
      {
        tracker: "77",
        agent: "claude",
        testCheckName: "Test",
        agentBranchPattern: /^agent\/issue-[0-9]+$/,
        ciTimeoutMs: 60_000,
      },
    );

    await expect(runner.runTrackerLoop()).rejects.toThrow(
      "tracker-matrix output is not a JSON array",
    );
  });
});

describe("parseTimeoutMinutes", () => {
  test("uses valid positive numbers", () => {
    expect(parseTimeoutMinutes("15")).toBe(15);
  });

  test("falls back to default for invalid values", () => {
    expect(parseTimeoutMinutes("0")).toBe(DEFAULT_CI_TIMEOUT_MINUTES);
    expect(parseTimeoutMinutes("-4")).toBe(DEFAULT_CI_TIMEOUT_MINUTES);
    expect(parseTimeoutMinutes("invalid")).toBe(DEFAULT_CI_TIMEOUT_MINUTES);
  });
});
