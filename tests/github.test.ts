import type { Mock } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: Mocking external modules requires any
type AnyMock = Mock<(...args: any[]) => any>;

import { describe, expect, it, mock } from "bun:test";
import * as github from "@actions/github";
import { createOctokitClient } from "../packages/action-common/src/github-client.js";

mock.module("@actions/github", () => ({
  getOctokit: mock(),
}));

describe("OctokitClient", () => {
  const token = "fake-token";
  const owner = "owner";
  const repo = "repo";

  it("listOpenIssues returns issues", async () => {
    const mockOctokit = {
      paginate: mock().mockResolvedValue([
        {
          number: 1,
          title: "Issue 1",
          labels: [{ name: "bug" }],
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://example/1",
          pull_request: null,
        },
        {
          number: 2,
          title: "PR 2",
          labels: [],
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://example/2",
          pull_request: {},
        },
      ]),
      rest: {
        issues: {
          listForRepo: {},
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const issues = await client.listOpenIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
    expect(issues[0].labels).toEqual([{ name: "bug" }]);
    expect(mockOctokit.paginate).toHaveBeenCalled();
  });

  it("listOpenPullRequests returns enriched PRs", async () => {
    const mockOctokit = {
      paginate: mock().mockResolvedValue([
        {
          number: 3,
          title: "PR 3",
          draft: false,
          updated_at: "2026-01-01T00:00:00Z",
          html_url: "https://example/3",
          head: { ref: "branch-3", sha: "sha-3" },
          base: { ref: "main" },
        },
      ]),
      rest: {
        pulls: {
          list: {},
        },
      },
      graphql: mock().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewDecision: "APPROVED",
            mergeStateStatus: "CLEAN",
            autoMergeRequest: { enabledAt: "2026-01-02T00:00:00Z" },
          },
        },
      }),
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const prs = await client.listOpenPullRequests();

    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(3);
    expect(prs[0].reviewDecision).toBe("APPROVED");
    expect(prs[0].isAutoMergeEnabled).toBe(true);
    expect(prs[0].mergeStateStatus).toBe("CLEAN");
    expect(mockOctokit.graphql).toHaveBeenCalled();
  });

  it("listWorkflowRuns returns runs", async () => {
    const mockOctokit = {
      rest: {
        actions: {
          listWorkflowRuns: mock().mockResolvedValue({
            data: {
              workflow_runs: [
                { id: 101, head_sha: "sha-101", status: "in_progress" },
              ],
            },
          }),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const runs = await client.listWorkflowRuns(
      "workflow.yml",
      "in_progress",
      "main",
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(101);
    expect(mockOctokit.rest.actions.listWorkflowRuns).toHaveBeenCalledWith({
      owner,
      repo,
      workflow_id: "workflow.yml",
      status: "in_progress",
      branch: "main",
      per_page: 50,
    });
  });

  it("listCheckRuns returns checks", async () => {
    const mockOctokit = {
      rest: {
        checks: {
          listForRef: mock().mockResolvedValue({
            data: {
              check_runs: [
                {
                  name: "Test",
                  status: "completed",
                  conclusion: "success",
                  started_at: "2026-01-01T00:00:00Z",
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
            },
          }),
        },
        repos: {
          getCombinedStatusForRef: mock().mockResolvedValue({
            data: {
              statuses: [
                {
                  context: "legacy-status",
                  state: "success",
                  created_at: "2026-01-01T00:00:00Z",
                  updated_at: "2026-01-01T00:00:00Z",
                },
              ],
            },
          }),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const checks = await client.listCheckRuns("sha-123");

    expect(checks).toHaveLength(2);
    expect(checks[0].name).toBe("Test");
    expect(checks[1].name).toBe("legacy-status");
    expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledWith({
      owner,
      repo,
      ref: "sha-123",
      per_page: 100,
    });
    expect(mockOctokit.rest.repos.getCombinedStatusForRef).toHaveBeenCalledWith(
      {
        owner,
        repo,
        ref: "sha-123",
      },
    );
  });

  it("listCheckRuns prefers check runs over same-name commit statuses", async () => {
    const mockOctokit = {
      rest: {
        checks: {
          listForRef: mock().mockResolvedValue({
            data: {
              check_runs: [
                {
                  name: "Test",
                  status: "completed",
                  conclusion: "failure",
                  started_at: "2026-01-01T00:00:00Z",
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
            },
          }),
        },
        repos: {
          getCombinedStatusForRef: mock().mockResolvedValue({
            data: {
              statuses: [
                {
                  context: "Test",
                  state: "pending",
                  created_at: "2026-01-01T00:01:00Z",
                  updated_at: "2026-01-01T00:01:00Z",
                },
              ],
            },
          }),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const checks = await client.listCheckRuns("sha-456");

    expect(checks).toHaveLength(1);
    expect(checks[0]).toEqual({
      name: "Test",
      status: "completed",
      conclusion: "failure",
      startedAt: "2026-01-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("listCheckRuns drops commit status Test when check run is CI / Test", async () => {
    const mockOctokit = {
      rest: {
        checks: {
          listForRef: mock().mockResolvedValue({
            data: {
              check_runs: [
                {
                  name: "CI / Test",
                  status: "completed",
                  conclusion: "success",
                  started_at: "2026-01-01T00:00:00Z",
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
            },
          }),
        },
        repos: {
          getCombinedStatusForRef: mock().mockResolvedValue({
            data: {
              statuses: [
                {
                  context: "Test",
                  state: "pending",
                  created_at: "2026-01-01T00:01:00Z",
                  updated_at: "2026-01-01T00:01:00Z",
                },
              ],
            },
          }),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const checks = await client.listCheckRuns("sha-789");

    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("CI / Test");
  });

  it("dispatchWorkflow calls createWorkflowDispatch", async () => {
    const mockOctokit = {
      rest: {
        actions: {
          createWorkflowDispatch: mock().mockResolvedValue({}),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    await client.dispatchWorkflow("workflow.yml", "main", { input1: "val1" });

    expect(
      mockOctokit.rest.actions.createWorkflowDispatch,
    ).toHaveBeenCalledWith({
      owner,
      repo,
      workflow_id: "workflow.yml",
      ref: "main",
      inputs: { input1: "val1" },
    });
  });

  it("createCommitStatus calls createCommitStatus", async () => {
    const mockOctokit = {
      rest: {
        repos: {
          createCommitStatus: mock().mockResolvedValue({}),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    await client.createCommitStatus(
      "sha-123",
      "pending",
      "Test",
      "Autopilot dispatching CI...",
      "https://example.com",
    );

    expect(mockOctokit.rest.repos.createCommitStatus).toHaveBeenCalledWith({
      owner,
      repo,
      sha: "sha-123",
      state: "pending",
      context: "Test",
      description: "Autopilot dispatching CI...",
      target_url: "https://example.com",
    });
  });

  it("listRecentlyMergedPullRequests filters merged PRs and clamps limit", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          list: mock().mockResolvedValue({
            data: [
              {
                number: 10,
                title: "Merged",
                body: "x",
                merged_at: "2026-01-01T00:00:00Z",
                head: { ref: "h", sha: "s" },
                base: { ref: "main" },
                html_url: "https://example/10",
              },
              {
                number: 11,
                title: "Closed not merged",
                merged_at: null,
                head: { ref: "h2", sha: "s2" },
                base: { ref: "main" },
                html_url: "https://example/11",
              },
            ],
          }),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const merged = await client.listRecentlyMergedPullRequests(0);
    expect(merged).toHaveLength(1);
    expect(merged[0].number).toBe(10);
    expect(mockOctokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 1 }),
    );

    await client.listRecentlyMergedPullRequests(500);
    expect(mockOctokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100 }),
    );
  });

  it("getDefaultBranch returns repo default", async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: mock().mockResolvedValue({
            data: { default_branch: "develop" },
          }),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    expect(await client.getDefaultBranch()).toBe("develop");
  });

  it("getIssueBody and updateIssueBody delegate to issues API", async () => {
    const issuesGet = mock().mockResolvedValue({
      data: { body: "hello" },
    });
    const issuesUpdate = mock().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        issues: {
          get: issuesGet,
          update: issuesUpdate,
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    expect(await client.getIssueBody(7)).toBe("hello");
    await client.updateIssueBody(7, "next");
    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        repo,
        issue_number: 7,
        body: "next",
      }),
    );
  });

  it("closeIssueWithComment posts comment when non-empty and always closes", async () => {
    const createComment = mock().mockResolvedValue({});
    const issuesUpdate = mock().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        issues: {
          createComment,
          update: issuesUpdate,
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    await client.closeIssueWithComment(5, "done");
    expect(createComment).toHaveBeenCalled();
    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 5,
        state: "closed",
        state_reason: "completed",
      }),
    );
  });

  it("closeIssueWithComment skips createComment when comment is blank", async () => {
    const createComment = mock().mockResolvedValue({});
    const issuesUpdate = mock().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        issues: {
          createComment,
          update: issuesUpdate,
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    await client.closeIssueWithComment(5, "   ");
    expect(createComment).not.toHaveBeenCalled();
    expect(issuesUpdate).toHaveBeenCalled();
  });

  it("getLatestCommitStatus returns matching state or null", async () => {
    const getCombined = mock().mockResolvedValue({
      data: {
        statuses: [
          { context: "Other", state: "success" },
          { context: "CI / Test", state: "pending" },
        ],
      },
    });
    const mockOctokit = {
      rest: {
        repos: {
          getCombinedStatusForRef: getCombined,
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    expect(await client.getLatestCommitStatus("sha", "Test")).toBe("pending");
    expect(await client.getLatestCommitStatus("sha", "missing")).toBeNull();
  });

  it("listReviews maps paginated reviews", async () => {
    const mockOctokit = {
      paginate: mock().mockResolvedValue([
        {
          state: "APPROVED",
          body: "lgtm",
          commit_id: "abc",
          user: { login: "reviewer" },
        },
      ]),
      rest: {
        pulls: {
          listReviews: {},
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const reviews = await client.listReviews(99);
    expect(reviews).toEqual([
      {
        state: "APPROVED",
        body: "lgtm",
        commitId: "abc",
        user: "reviewer",
      },
    ]);
  });

  it("reRunWorkflowFailedJobs delegates to actions API", async () => {
    const reRun = mock().mockResolvedValue({});
    const mockOctokit = {
      rest: {
        actions: {
          reRunWorkflowFailedJobs: reRun,
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    await client.reRunWorkflowFailedJobs(555);
    expect(reRun).toHaveBeenCalledWith({
      owner,
      repo,
      run_id: 555,
    });
  });

  it("listCheckRuns logs when no checks or statuses exist", async () => {
    const mockOctokit = {
      rest: {
        checks: {
          listForRef: mock().mockResolvedValue({
            data: { check_runs: [] },
          }),
        },
        repos: {
          getCombinedStatusForRef: mock().mockResolvedValue({
            data: { statuses: [] },
          }),
        },
      },
    };
    (github.getOctokit as AnyMock).mockReturnValue(mockOctokit);

    const client = createOctokitClient(token, owner, repo);
    const checks = await client.listCheckRuns("sha-empty");
    expect(checks).toHaveLength(0);
  });
});
