import type * as exec from "@actions/exec";
import { matchesGateCheckName } from "@caretta/action-common/check-runs";
import type { ExecClient } from "@caretta/action-common/exec-client";
import type { GitHubClient } from "@caretta/action-common/github-client";
import type {
  CheckRun,
  CommitStatusState,
  Issue,
  MergedPullRequest,
  PullRequest,
  PullRequestReview,
  WorkflowRun,
} from "@caretta/action-common/types";

export interface ExecCall {
  command: string;
  args: string[];
  options?: exec.ExecOptions;
}

export class FakeExec implements ExecClient {
  readonly calls: ExecCall[] = [];
  stdout = "";
  /** Optional override: return a non-zero exit code for specific calls. */
  execHandler?: (commandLine: string, args: string[]) => number;

  async exec(
    commandLine: string,
    args?: string[],
    options?: exec.ExecOptions,
  ): Promise<number> {
    this.calls.push({ command: commandLine, args: args ?? [], options });
    return this.execHandler?.(commandLine, args ?? []) ?? 0;
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
  getIssueBodyShouldFail?: (issueNumber: number) => boolean;
  deleteBranchShouldFail?: (refName: string) => boolean;
  /** Pre-seeded commit statuses (e.g. stale pending before reconcile). */
  initialCommitStatuses?: readonly StatusCall[];
  /** Consume N failures on `createCommitStatus` calls, then succeed. */
  createCommitStatusFailTimes?: number;
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
  readonly enableAutoMergeCalls: number[] = [];
  readonly mergedPrs: { prNumber: number; method: string }[] = [];
  readonly deletedBranches: string[] = [];
  /**
   * When set, `enableAutoMerge` throws an error containing this message
   * the first time it's called for the matching PR number. Subsequent calls
   * succeed. Used to simulate GitHub's "Pull request is in clean status"
   * rejection.
   */
  enableAutoMergeErrorForPr?: { prNumber: number; message: string };
  readonly retargetCalls: Array<{ prNumber: number; newBaseRef: string }> = [];
  private commitStatusFailsRemaining = 0;
  private readonly issueBodies: Record<number, string>;

  constructor(private readonly data: Partial<FakeData> = {}) {
    this.issueBodies = { ...(data.issueBodies ?? {}) };
    this.commitStatusFailsRemaining = data.createCommitStatusFailTimes ?? 0;
    for (const s of data.initialCommitStatuses ?? []) {
      this.createdStatuses.push(s);
    }
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
    if (this.data.getIssueBodyShouldFail?.(issueNumber)) {
      throw new Error(`getIssueBody failed for #${issueNumber}`);
    }
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

  async deleteBranch(refName: string): Promise<void> {
    if (this.data.deleteBranchShouldFail?.(refName)) {
      throw new Error(`deleteBranch failed for ${refName}`);
    }
    this.deletedBranches.push(refName);
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
    const checkRunNames = new Set(results.map((c) => c.name));

    // Add manually created statuses with increasing timestamps. Mirror the
    // OctokitClient's shadowing rule: a commit status is dropped when any
    // check_run for the same gate name is already present, so the gate's
    // authoritative result wins over a stale autopilot-written status.
    let offset = 0;
    for (const s of this.createdStatuses.filter((st) => st.sha === sha)) {
      const shadowed = [...checkRunNames].some(
        (cn) =>
          cn === s.context ||
          matchesGateCheckName(cn, s.context) ||
          matchesGateCheckName(s.context, cn),
      );
      if (shadowed) continue;
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

  async getLatestCommitStatus(
    sha: string,
    context: string,
  ): Promise<CommitStatusState | null> {
    const matches = this.createdStatuses.filter(
      (s) =>
        s.sha === sha &&
        (s.context === context ||
          matchesGateCheckName(s.context, context) ||
          matchesGateCheckName(context, s.context)),
    );
    if (matches.length === 0) return null;
    return matches[matches.length - 1].state as CommitStatusState;
  }

  async listReviews(
    pullNumber: number,
  ): Promise<import("@caretta/action-common/types").PullRequestReview[]> {
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
    if (this.commitStatusFailsRemaining > 0) {
      this.commitStatusFailsRemaining -= 1;
      throw new Error("FakeGitHub: createCommitStatus failed");
    }
    this.createdStatuses.push({ sha, state, context, description, targetUrl });
  }

  async enableAutoMerge(prNumber: number): Promise<void> {
    this.enableAutoMergeCalls.push(prNumber);
    if (
      this.enableAutoMergeErrorForPr &&
      this.enableAutoMergeErrorForPr.prNumber === prNumber
    ) {
      const msg = this.enableAutoMergeErrorForPr.message;
      // Consume so subsequent calls succeed.
      this.enableAutoMergeErrorForPr = undefined;
      throw new Error(msg);
    }
    // Mirror realistic semantics: subsequent reads see the PR with
    // auto-merge enabled.
    const pr = (this.data.prs ?? []).find((p) => p.number === prNumber);
    if (pr) {
      (pr as { isAutoMergeEnabled: boolean }).isAutoMergeEnabled = true;
    }
  }

  async mergePullRequest(
    prNumber: number,
    method: "SQUASH" | "MERGE" | "REBASE",
    _expectedHeadOid: string,
  ): Promise<void> {
    const prs = (this.data.prs ?? []) as PullRequest[];
    const merged = (this.data.mergedPrs ?? []) as MergedPullRequest[];
    const idx = prs.findIndex((p) => p.number === prNumber);
    if (idx >= 0) {
      const pr = prs[idx] as PullRequest;
      (pr as { isAutoMergeEnabled: boolean }).isAutoMergeEnabled = false;
      prs.splice(idx, 1);
      merged.push({
        number: pr.number,
        title: pr.title,
        body: "",
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        mergedAt: "2026-01-01T00:00:00Z",
        url: pr.url,
      });
    }
    this.mergedPrs.push({ prNumber, method });
  }

  async retargetPullRequest(
    prNumber: number,
    newBaseRef: string,
  ): Promise<void> {
    this.retargetCalls.push({ prNumber, newBaseRef });
    const pr = (this.data.prs ?? []).find((p) => p.number === prNumber);
    if (pr) {
      (pr as { baseRefName: string }).baseRefName = newBaseRef;
    }
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
    baseRefName: partial.baseRefName ?? "main",
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
    import("@caretta/action-common/types").AutopilotConfig
  > = {},
): import("@caretta/action-common/types").AutopilotConfig {
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
