import * as github from "@actions/github";
import type { CheckRun, Issue, PullRequest, WorkflowRun } from "./types.js";

export interface GitHubClient {
  listOpenIssues(): Promise<Issue[]>;
  listOpenPullRequests(): Promise<PullRequest[]>;
  listWorkflowRuns(
    workflow: string,
    status: string,
    branch?: string,
  ): Promise<WorkflowRun[]>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<void>;
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
          };
        };
      }>(
        `query($owner:String!,$repo:String!,$number:Int!){
          repository(owner:$owner,name:$repo){
            pullRequest(number:$number){ reviewDecision mergeStateStatus }
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
        mergeStateStatus: detail.repository.pullRequest.mergeStateStatus,
      });
    }
    return enriched;
  }

  async listWorkflowRuns(
    workflow: string,
    status: string,
    branch?: string,
  ): Promise<WorkflowRun[]> {
    const res = await this.octokit.rest.actions.listWorkflowRuns({
      owner: this.owner,
      repo: this.repo,
      workflow_id: workflow,
      status: status as "queued" | "in_progress",
      branch,
      per_page: 50,
    });
    return res.data.workflow_runs.map((r) => ({
      id: r.id,
      headSha: r.head_sha,
      status: r.status ?? "",
    }));
  }

  async listCheckRuns(sha: string): Promise<CheckRun[]> {
    const res = await this.octokit.rest.checks.listForRef({
      owner: this.owner,
      repo: this.repo,
      ref: sha,
      per_page: 100,
    });
    return res.data.check_runs.map((c) => ({
      name: c.name,
      startedAt: c.started_at,
      createdAt: (c as { created_at?: string }).created_at ?? null,
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
}
