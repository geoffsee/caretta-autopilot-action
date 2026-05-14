import { describe, expect, test } from "bun:test";
import type * as actionsExec from "@actions/exec";
import type { ExecClient } from "../src/exec.js";
import {
  FactoryCycleRunner,
  findOpenSprint,
} from "../src/factory-cycle-runner.js";
import type { GitHubClient } from "../src/github.js";
import type {
  CheckRun,
  Issue,
  PullRequest,
  WorkflowRun,
} from "../src/types.js";

interface ExecCall {
  readonly commandLine: string;
  readonly args: string[];
  readonly options?: actionsExec.ExecOptions;
}

class FakeExec implements ExecClient {
  readonly calls: ExecCall[] = [];

  async exec(
    commandLine: string,
    args?: string[],
    options?: actionsExec.ExecOptions,
  ): Promise<number> {
    this.calls.push({ commandLine, args: args ?? [], options });
    return 0;
  }

  async getExecOutput(): Promise<actionsExec.ExecOutput> {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }
}

class FakeGitHub implements GitHubClient {
  constructor(private readonly issues: Issue[]) {}

  async listOpenIssues(): Promise<Issue[]> {
    return [...this.issues];
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    return [];
  }

  async listWorkflowRuns(): Promise<WorkflowRun[]> {
    return [];
  }

  async listCheckRuns(): Promise<CheckRun[]> {
    return [];
  }

  async dispatchWorkflow(): Promise<void> {}
}

function makeIssue(number: number, partial: Partial<Issue> = {}): Issue {
  return {
    number,
    title: partial.title ?? `Issue ${number}`,
    labels: partial.labels ?? [],
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00Z",
    url: partial.url ?? `https://example/issues/${number}`,
  };
}

function taskFromArgs(args: string[]): string | null {
  const presetIdx = args.indexOf("software-factory");
  if (presetIdx < 0 || presetIdx + 1 >= args.length) return null;
  return args[presetIdx + 1];
}

describe("FactoryCycleRunner", () => {
  test("runs full cycle when no open sprint exists", async () => {
    const exec = new FakeExec();
    const runner = new FactoryCycleRunner(
      "/mock/caretta",
      { GH_TOKEN: "token" },
      exec,
      new FakeGitHub([makeIssue(1)]),
      "claude",
    );

    const result = await runner.runFactoryCycle();
    expect(result).toEqual({ skipped: false, activeSprint: "" });

    const tasks = exec.calls.map((call) => taskFromArgs(call.args));
    expect(tasks).toEqual(["housekeeping", "run", "run", "run", "run"]);
    expect(exec.calls[1].args.at(-1)).toBe("ideation");
    expect(exec.calls[2].args.at(-1)).toBe("report-research");
    expect(exec.calls[3].args.at(-1)).toBe("strategic-review");
    expect(exec.calls[4].args.at(-1)).toBe("sprint-planning");
  });

  test("skips ideation cycle when an open sprint issue exists", async () => {
    const exec = new FakeExec();
    const runner = new FactoryCycleRunner(
      "/mock/caretta",
      { GH_TOKEN: "token" },
      exec,
      new FakeGitHub([makeIssue(42, { labels: [{ name: "sprint" }] })]),
      "claude",
    );

    const result = await runner.runFactoryCycle();
    expect(result).toEqual({ skipped: true, activeSprint: "42" });

    const tasks = exec.calls.map((call) => taskFromArgs(call.args));
    expect(tasks).toEqual(["housekeeping"]);
  });
});

describe("findOpenSprint", () => {
  test("returns null without sprint-labeled issues", () => {
    expect(findOpenSprint([makeIssue(1), makeIssue(2)])).toBeNull();
  });

  test("returns the most recently updated sprint issue", () => {
    const sprint = findOpenSprint([
      makeIssue(10, {
        labels: [{ name: "sprint" }],
        updatedAt: "2026-01-02T00:00:00Z",
      }),
      makeIssue(11, {
        labels: [{ name: "sprint" }],
        updatedAt: "2026-03-01T00:00:00Z",
      }),
      makeIssue(12, {
        labels: [{ name: "bug" }],
        updatedAt: "2026-04-01T00:00:00Z",
      }),
    ]);

    expect(sprint?.number).toBe(11);
  });
});
