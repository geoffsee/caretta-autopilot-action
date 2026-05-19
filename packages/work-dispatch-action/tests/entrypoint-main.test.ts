import { describe, expect, mock, test } from "bun:test";
import type { ExecClient } from "../../action-common/src/exec-client.js";
import type { GitHubClient } from "../../action-common/src/github-client.js";

const coreInputs: Record<string, string> = {
  "github-token": "tok",
  "caretta-version": "latest",
  agent: "claude",
  context: "",
  tracker: "11",
  "ci-timeout-minutes": "1",
};

mock.module("@actions/core", () => ({
  getInput: (name: string, opts?: { required?: boolean }) => {
    const v = coreInputs[name] ?? "";
    if (opts?.required && v === "") throw new Error(name);
    return v;
  },
  getBooleanInput: () => false,
  setOutput: mock(() => {}),
  setFailed: mock(() => {}),
  info: mock(() => {}),
  warning: mock(() => {}),
  setSecret: mock(() => {}),
  addPath: mock(() => {}),
  summary: {
    addRaw() {
      return this;
    },
    async write() {},
  },
}));

mock.module("@actions/github", () => ({
  context: { repo: { owner: "o", repo: "r" } },
}));

const fakeGh: GitHubClient = {
  async listOpenIssues() {
    return [];
  },
  async listOpenPullRequests() {
    return [];
  },
  async listRecentlyMergedPullRequests() {
    return [];
  },
  async getDefaultBranch() {
    return "main";
  },
  async getIssueBody() {
    return "";
  },
  async updateIssueBody() {},
  async closeIssueWithComment() {},
  async listWorkflowRuns() {
    return [];
  },
  async listCheckRuns() {
    return [];
  },
  async getLatestCommitStatus() {
    return null;
  },
  async listReviews() {
    return [];
  },
  async dispatchWorkflow() {},
  async reRunWorkflowFailedJobs() {},
  async createCommitStatus() {},
};

const fakeExec: ExecClient = {
  async exec() {
    return 0;
  },
  async getExecOutput() {
    return { exitCode: 0, stdout: "[]", stderr: "" };
  },
};

const trackerDeps = {
  createGitHubClient: () => fakeGh,
  createExecClient: () => fakeExec,
  installCaretta: async () => ({ binaryPath: "/tmp/caretta", version: "v9" }),
  installLinuxRuntimeDeps: async () => {},
  materializeBotPrivateKey: () => {},
};

describe("work-dispatch main()", () => {
  test("loads composition root and runs the action", async () => {
    const { main } = await import(
      "../src/presentation/github-action/controller.js"
    );
    await main(trackerDeps);
    expect(coreInputs.tracker).toBe("11");
  });
});
