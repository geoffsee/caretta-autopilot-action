import type * as exec from "@actions/exec";
import type { ExecClient } from "../src/exec.js";
import type { GitHubClient } from "../src/github.js";
import type {
  CheckRun,
  Issue,
  MergedPullRequest,
  PullRequest,
  PullRequestReview,
  WorkflowRun,
} from "../src/types.js";

export interface ExecCall {
  command: string;
  args: string[];
  options?: exec.ExecOptions;
}

export class FakeExec implements ExecClient {
  readonly calls: ExecCall[] = [];
  stdout = "";

  async exec(
    commandLine: string,
    args?: string[],
    options?: exec.ExecOptions,
  ): Promise<number> {
    this.calls.push({ command: commandLine, args: args ?? [], options });
    return 0;
  }

  async getExecOutput(
    commandLine: string,
    args?: string[],
    options?: exec.ExecOptions,
  ): Promise<exec.ExecOutput> {
    this.calls.push({ command: commandLine, args: args ?? [], options });
    return {
      exitCode: 0,
      stdout: this.stdout,
      stderr: "",
    };
  }
}

export interface DispatchCall {
  workflow: string;
  ref: string;
  inputs?: Record<string, string>;
}

export interface FakeData {
  issues: readonly Issue[];
  prs: readonly PullRequest[];
  mergedPrs: readonly MergedPullRequest[];
  defaultBranch: string;
  issueBodies: Record<number, string>;
  checksBySha: Record<string, readonly CheckRun[] | undefined>;
  reviewsByPr: Record<number, readonly PullRequestReview[] | undefined>;
  runsByKey: Record<string, readonly WorkflowRun[] | undefined>;
  dispatchShouldFail: (workflow: string, ref: string) => boolean;
  closeIssueShouldFail: (issueNumber: number) => boolean;
  updateIssueBodyShouldFail: (issueNumber: number) => boolean;
}

export interface CloseIssueCall {
  issueNumber: number;
  comment: string;
}

export interface UpdateIssueBodyCall {
  issueNumber: number;
  body: string;
}

export class FakeGitHub implements GitHubClient {
  readonly dispatched: DispatchCall[] = [];
  readonly closedIssues: CloseIssueCall[] = [];
  readonly updatedIssueBodies: UpdateIssueBodyCall[] = [];
  private readonly issueBodies: Record<number, string>;

  constructor(private readonly data: Partial<FakeData> = {}) {
    this.issueBodies = { ...(data.issueBodies ?? {}) };
  }

  async listOpenIssues(): Promise<Issue[]> {
    return [...(this.data.issues ?? [])];
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    return [...(this.data.prs ?? [])];
  }

  async listRecentlyMergedPullRequests(
    _limit?: number,
  ): Promise<MergedPullRequest[]> {
    return [...(this.data.mergedPrs ?? [])];
  }

  async getDefaultBranch(): Promise<string> {
    return this.data.defaultBranch ?? "main";
  }

  async getIssueBody(issueNumber: number): Promise<string> {
    return this.issueBodies[issueNumber] ?? "";
  }

  async updateIssueBody(issueNumber: number, body: string): Promise<void> {
    if (this.data.updateIssueBodyShouldFail?.(issueNumber)) {
      throw new Error(`updateIssueBody failed for #${issueNumber}`);
    }
    this.issueBodies[issueNumber] = body;
    this.updatedIssueBodies.push({ issueNumber, body });
  }

  async closeIssueWithComment(
    issueNumber: number,
    comment: string,
  ): Promise<void> {
    if (this.data.closeIssueShouldFail?.(issueNumber)) {
      throw new Error(`closeIssueWithComment failed for #${issueNumber}`);
    }
    this.closedIssues.push({ issueNumber, comment });
  }

  async listWorkflowRuns(
    workflow: string,
    status: string,
    branch?: string,
  ): Promise<WorkflowRun[]> {
    const key = `${workflow}|${status}|${branch ?? ""}`;
    return [...(this.data.runsByKey?.[key] ?? [])];
  }

  async listCheckRuns(sha: string): Promise<CheckRun[]> {
    return [...(this.data.checksBySha?.[sha] ?? [])];
  }

  async listReviews(pullNumber: number): Promise<PullRequestReview[]> {
    return [...(this.data.reviewsByPr?.[pullNumber] ?? [])];
  }

  async dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<void> {
    if (this.data.dispatchShouldFail?.(workflow, ref)) {
      throw new Error(`dispatch failed for ${workflow} on ${ref}`);
    }
    this.dispatched.push({ workflow, ref, inputs });
  }
}

export function makeIssue(partial: Partial<Issue> & { number: number }): Issue {
  return {
    number: partial.number,
    title: partial.title ?? `Issue ${partial.number}`,
    labels: partial.labels ?? [],
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00Z",
    url: partial.url ?? `https://example/issues/${partial.number}`,
  };
}

export function makePR(
  partial: Partial<PullRequest> & { number: number },
): PullRequest {
  return {
    number: partial.number,
    title: partial.title ?? `PR ${partial.number}`,
    isDraft: partial.isDraft ?? false,
    reviewDecision: partial.reviewDecision ?? null,
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00Z",
    url: partial.url ?? `https://example/pull/${partial.number}`,
    headRefName: partial.headRefName ?? `agent/issue-${partial.number}`,
    headRefOid: partial.headRefOid ?? `sha-${partial.number}`,
    mergeStateStatus: partial.mergeStateStatus ?? "CLEAN",
    isAutoMergeEnabled: partial.isAutoMergeEnabled ?? false,
  };
}

export function makeMergedPR(
  partial: Partial<MergedPullRequest> & { number: number },
): MergedPullRequest {
  return {
    number: partial.number,
    title: partial.title ?? `PR ${partial.number}`,
    body: partial.body ?? "",
    headRefName: partial.headRefName ?? `agent/issue-${partial.number}`,
    baseRefName: partial.baseRefName ?? "main",
    mergedAt: partial.mergedAt ?? "2026-05-15T00:00:00Z",
    url: partial.url ?? `https://example/pull/${partial.number}`,
  };
}

export function makeConfig(
  overrides: Partial<import("../src/types.js").AutopilotConfig> = {},
): import("../src/types.js").AutopilotConfig {
  return {
    carettaVersion: "latest",
    agent: "claude",
    context: "test context",
    dryRun: false,
    enableDispatch: true,
    ciWorkflow: "ci.yml",
    agentBranchPattern: /^agent\/issue-[0-9]+$/,
    testCheckName: "Test",
    gitUserName: "caretta-autopilot[bot]",
    gitUserEmail: "caretta-autopilot[bot]@users.noreply.github.com",
    ...overrides,
  };
}
