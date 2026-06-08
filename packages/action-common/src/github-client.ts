import * as core from "@actions/core";
import * as github from "@actions/github";
import { matchesGateCheckName } from "./check-runs.js";
import type {
  CheckRun,
  CommitStatusState,
  Issue,
  MergedPullRequest,
  PullRequest,
  PullRequestReview,
  WorkflowRun,
} from "./types.js";

export interface GitHubClient {
  listOpenIssues(): Promise<Issue[]>;
  listOpenPullRequests(): Promise<PullRequest[]>;
  listRecentlyMergedPullRequests(limit?: number): Promise<MergedPullRequest[]>;
  getDefaultBranch(): Promise<string>;
  getIssueBody(issueNumber: number): Promise<string>;
  updateIssueBody(issueNumber: number, body: string): Promise<void>;
  closeIssueWithComment(issueNumber: number, comment: string): Promise<void>;
  /**
   * Delete a branch ref from `refs/heads/<name>`. Implemented by the production
   * GitHub client and used for stack cleanup after merged agent PRs.
   */
  deleteBranch?(refName: string): Promise<void>;
  listWorkflowRuns(
    workflow: string,
    status?: string,
    branch?: string,
  ): Promise<WorkflowRun[]>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  /**
   * Latest commit status state for `context` on `sha`, or `null` if no status
   * with that context (matched against gate naming) has been recorded.
   * Used to detect a stale `pending` commit status that the autopilot wrote
   * pre-dispatch and that GitHub's PR rollup is still showing even though the
   * workflow's check_run has since completed.
   */
  getLatestCommitStatus(
    sha: string,
    context: string,
  ): Promise<CommitStatusState | null>;
  listReviews(pullNumber: number): Promise<PullRequestReview[]>;
  dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<void>;
  reRunWorkflowFailedJobs(runId: number): Promise<void>;
  createCommitStatus(
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    context: string,
    description: string,
    targetUrl?: string,
  ): Promise<void>;
  /**
   * Enable squash auto-merge on the given PR. GitHub will merge it once all
   * branch-protection conditions are satisfied (required checks, approvals,
   * branch up-to-date). Used by the autopilot's automerge gate to unstick
   * merge-ready agent PRs when caretta's `--automerge-queue` bails on an
   * empty tracker-matrix (parser-regression bypass; see post-mortem
   * 2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md).
   */
  enableAutoMerge(prNumber: number): Promise<void>;
  /**
   * Merge the given PR directly using the specified method. `expectedHeadOid`
   * is passed as a merge precondition (`sha`) so GitHub rejects the merge if
   * the PR advanced after evaluation. Required as a companion to
   * `enableAutoMerge` because GitHub's `enablePullRequestAutoMerge` mutation
   * rejects PRs with `mergeStateStatus: CLEAN` (no pending conditions to wait
   * on). The autopilot's automerge gate calls this when the PR is already
   * merge-ready right now; `enableAutoMerge` only makes sense when something
   * is still pending. See post-mortem
   * 2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md
   * § "Manual unstick of PR #159".
   */
  mergePullRequest(
    prNumber: number,
    method: "SQUASH" | "MERGE" | "REBASE",
    expectedHeadOid: string,
  ): Promise<void>;
  /**
   * Change a PR's base branch. Used after auto-rebasing a stacked agent PR
   * whose parent has merged into the default branch, so the PR can then be
   * picked up by the normal default-branch auto-merge path.
   */
  retargetPullRequest(prNumber: number, newBaseRef: string): Promise<void>;
}

type Octokit = ReturnType<typeof github.getOctokit>;

export function createOctokitClient(
  token: string,
  owner: string,
  repo: string,
): GitHubClient {
  const octokit = github.getOctokit(token);
  return new OctokitClient(octokit, owner, repo);
}

class OctokitClient implements GitHubClient {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async listOpenIssues(): Promise<Issue[]> {
    const res = await this.octokit.paginate(
      this.octokit.rest.issues.listForRepo,
      {
        owner: this.owner,
        repo: this.repo,
        state: "open",
        per_page: 100,
      },
    );
    return res
      .filter((i) => !i.pull_request)
      .slice(0, 100)
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: (i.labels ?? []).map((l) =>
          typeof l === "string" ? { name: l } : { name: l.name ?? "" },
        ),
        updatedAt: i.updated_at,
        url: i.html_url,
      }));
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const list = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });
    const trimmed = list.slice(0, 100);
    const enriched: PullRequest[] = [];
    for (const pr of trimmed) {
      const detail = await this.octokit.graphql<{
        repository: {
          pullRequest: {
            reviewDecision: string | null;
            mergeStateStatus: string;
            autoMergeRequest: { enabledAt: string } | null;
          };
        };
      }>(
        `query($owner:String!,$repo:String!,$number:Int!){
          repository(owner:$owner,name:$repo){
            pullRequest(number:$number){ reviewDecision mergeStateStatus autoMergeRequest { enabledAt } }
          }
        }`,
        { owner: this.owner, repo: this.repo, number: pr.number },
      );
      enriched.push({
        number: pr.number,
        title: pr.title,
        isDraft: pr.draft ?? false,
        reviewDecision: detail.repository.pullRequest.reviewDecision,
        updatedAt: pr.updated_at,
        url: pr.html_url,
        headRefName: pr.head.ref,
        headRefOid: pr.head.sha,
        baseRefName: pr.base.ref,
        mergeStateStatus: detail.repository.pullRequest.mergeStateStatus,
        isAutoMergeEnabled: !!detail.repository.pullRequest.autoMergeRequest,
      });
    }
    return enriched;
  }

  async listRecentlyMergedPullRequests(
    limit = 30,
  ): Promise<MergedPullRequest[]> {
    const res = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: Math.min(Math.max(limit, 1), 100),
    });
    return res.data
      .filter((pr) => !!pr.merged_at)
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        headRefName: pr.head.ref,
        baseRefName: pr.base.ref,
        mergedAt: pr.merged_at as string,
        url: pr.html_url,
      }));
  }

  async getDefaultBranch(): Promise<string> {
    const res = await this.octokit.rest.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    return res.data.default_branch;
  }

  async getIssueBody(issueNumber: number): Promise<string> {
    const res = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return res.data.body ?? "";
  }

  async updateIssueBody(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async closeIssueWithComment(
    issueNumber: number,
    comment: string,
  ): Promise<void> {
    if (comment.trim().length > 0) {
      await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body: comment,
      });
    }
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: "closed",
      state_reason: "completed",
    });
  }

  async deleteBranch(refName: string): Promise<void> {
    await this.octokit.rest.git.deleteRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${refName}`,
    });
  }

  async listWorkflowRuns(
    workflow: string,
    status?: string,
    branch?: string,
  ): Promise<WorkflowRun[]> {
    const res = await this.octokit.rest.actions.listWorkflowRuns({
      owner: this.owner,
      repo: this.repo,
      workflow_id: workflow,
      status: status as "queued" | "in_progress" | "completed",
      branch,
      per_page: 50,
    });
    return res.data.workflow_runs.map((r) => ({
      id: r.id,
      headSha: r.head_sha,
      status: r.status ?? "",
      conclusion: r.conclusion ?? null,
    }));
  }

  async listCheckRuns(sha: string): Promise<CheckRun[]> {
    core.info(`listCheckRuns: fetching checks for ref ${sha}`);
    const [checks, statuses] = await Promise.all([
      this.octokit.rest.checks.listForRef({
        owner: this.owner,
        repo: this.repo,
        ref: sha,
        per_page: 100,
      }),
      this.octokit.rest.repos.getCombinedStatusForRef({
        owner: this.owner,
        repo: this.repo,
        ref: sha,
      }),
    ]);

    const results: CheckRun[] = [];

    const checkRunNames = new Set<string>();
    for (const c of checks.data.check_runs) {
      core.info(
        `listCheckRuns: found check run "${c.name}" - status: ${c.status}, conclusion: ${c.conclusion}`,
      );
      checkRunNames.add(c.name);
      results.push({
        name: c.name,
        status: c.status as CheckRun["status"],
        conclusion: c.conclusion as CheckRun["conclusion"],
        startedAt: c.started_at,
        createdAt: (c as { created_at?: string }).created_at ?? c.started_at,
      });
    }

    for (const s of statuses.data.statuses) {
      const shadowedByCheck = [...checkRunNames].some(
        (cn) => cn === s.context || matchesGateCheckName(cn, s.context),
      );
      if (shadowedByCheck) {
        core.info(
          `listCheckRuns: skipping commit status "${s.context}" because a check run already covers this gate for this ref.`,
        );
        continue;
      }

      core.info(
        `listCheckRuns: found commit status "${s.context}" - state: ${s.state}`,
      );
      let status: CheckRun["status"] = "completed";
      let conclusion: CheckRun["conclusion"] = null;

      if (s.state === "pending") {
        status = "in_progress";
      } else if (s.state === "success") {
        conclusion = "success";
      } else if (s.state === "failure" || s.state === "error") {
        conclusion = "failure";
      }

      results.push({
        name: s.context,
        status,
        conclusion,
        startedAt: s.created_at,
        createdAt: s.updated_at,
      });
    }

    if (results.length === 0) {
      core.info(`listCheckRuns: no checks or statuses found for ref ${sha}`);
    }

    return results;
  }

  async getLatestCommitStatus(
    sha: string,
    context: string,
  ): Promise<CommitStatusState | null> {
    const res = await this.octokit.rest.repos.getCombinedStatusForRef({
      owner: this.owner,
      repo: this.repo,
      ref: sha,
    });
    const match = res.data.statuses.find(
      (s) =>
        s.context === context ||
        matchesGateCheckName(s.context, context) ||
        matchesGateCheckName(context, s.context),
    );
    if (!match) return null;
    return match.state as CommitStatusState;
  }

  async listReviews(pullNumber: number): Promise<PullRequestReview[]> {
    const res = await this.octokit.paginate(
      this.octokit.rest.pulls.listReviews,
      {
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
        per_page: 100,
      },
    );
    return res.map((r) => ({
      state: r.state,
      body: r.body ?? "",
      commitId: r.commit_id ?? "",
      user: r.user?.login ?? "",
    }));
  }

  async dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<void> {
    await this.octokit.rest.actions.createWorkflowDispatch({
      owner: this.owner,
      repo: this.repo,
      workflow_id: workflow,
      ref,
      inputs,
    });
  }

  async reRunWorkflowFailedJobs(runId: number): Promise<void> {
    await this.octokit.rest.actions.reRunWorkflowFailedJobs({
      owner: this.owner,
      repo: this.repo,
      run_id: runId,
    });
  }

  async createCommitStatus(
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    context: string,
    description: string,
    targetUrl?: string,
  ): Promise<void> {
    await this.octokit.rest.repos.createCommitStatus({
      owner: this.owner,
      repo: this.repo,
      sha,
      state,
      context,
      description,
      target_url: targetUrl,
    });
  }

  async enableAutoMerge(prNumber: number): Promise<void> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    await this.octokit.graphql(
      `mutation($prId: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: SQUASH }) {
          clientMutationId
        }
      }`,
      { prId: data.node_id },
    );
  }

  async mergePullRequest(
    prNumber: number,
    method: "SQUASH" | "MERGE" | "REBASE",
    expectedHeadOid: string,
  ): Promise<void> {
    const restMethod = (
      { SQUASH: "squash", MERGE: "merge", REBASE: "rebase" } as const
    )[method];
    await this.octokit.rest.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      sha: expectedHeadOid,
      merge_method: restMethod,
    });
  }

  async retargetPullRequest(
    prNumber: number,
    newBaseRef: string,
  ): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      base: newBaseRef,
    });
  }
}
