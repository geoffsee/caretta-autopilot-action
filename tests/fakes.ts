import type * as exec from "@actions/exec";
import type { ExecClient } from "../packages/action-common/src/exec-client.js";
import type { GitHubClient } from "../packages/action-common/src/github-client.js";
import type {
  CheckRun,
  Issue,
  MergedPullRequest,
  PullRequest,
  PullRequestReview,
  WorkflowRun,
} from "../packages/action-common/src/types.js";

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

export interface StatusCall {
  sha: string;
  state: string;
  context: string;
  description: string;
  targetUrl?: string;
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
  readonly reRunCalls: number[] = [];
  readonly createdStatuses: StatusCall[] = [];
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
    status?: string,
    branch?: string,
  ): Promise<WorkflowRun[]> {
    const key = `${workflow}|${status ?? "any"}|${branch ?? ""}`;
    return [...(this.data.runsByKey?.[key] ?? [])];
  }

  async listCheckRuns(sha: string): Promise<CheckRun[]> {
    const results = [...(this.data.checksBySha?.[sha] ?? [])];

    // Add manually created statuses with increasing timestamps
    let offset = 0;
    for (const s of this.createdStatuses.filter((st) => st.sha === sha)) {
      offset += 1000; // +1 second for each status
      const time = new Date(
        new Date("2026-01-01T00:00:00Z").getTime() + offset,
      ).toISOString();
      results.push({
        name: s.context,
        status: s.state === "pending" ? "in_progress" : "completed",
        conclusion:
          s.state === "pending" ? null : (s.state as CheckRun["conclusion"]),
        startedAt: time,
        createdAt: time,
      });
    }

    return results;
  }

  async listReviews(
    pullNumber: number,
  ): Promise<
    import("../packages/action-common/src/types.js").PullRequestReview[]
  > {
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

  async reRunWorkflowFailedJobs(runId: number): Promise<void> {
    this.reRunCalls.push(runId);
  }

  async createCommitStatus(
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    context: string,
    description: string,
    targetUrl?: string,
  ): Promise<void> {
    this.createdStatuses.push({ sha, state, context, description, targetUrl });
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
  overrides: Partial<
    import("../packages/action-common/src/types.js").AutopilotConfig
  > = {},
): import("../packages/action-common/src/types.js").AutopilotConfig {
  return {
    carettaVersion: "latest",
    agent: "claude",
    context: "test context",
    dryRun: false,
    enableDispatch: true,
    ciWorkflow: "ci.yml",
    agentBranchPattern: /^agent\/issue-[0-9]+(?:-.*)?$/,
    testCheckName: "Test",
    gitUserName: "caretta-autopilot[bot]",
    gitUserEmail: "caretta-autopilot[bot]@users.noreply.github.com",
    ...overrides,
  };
}
