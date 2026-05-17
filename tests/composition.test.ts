import { describe, expect, test } from "bun:test";
import type {
  ActionRuntime,
  SummaryWriter,
} from "../packages/action-common/src/action-runtime.js";
import type { ExecClient } from "../packages/action-common/src/exec-client.js";
import type { GitHubClient } from "../packages/action-common/src/github-client.js";
import { createAutopilotComposition } from "../src/composition/root.js";
import {
  AutopilotActionController,
  type MainDependencies,
} from "../src/presentation/github-action/controller.js";

class FakeSummary implements SummaryWriter {
  raw: string[] = [];

  addRaw(content: string): SummaryWriter {
    this.raw.push(content);
    return this;
  }

  async write(): Promise<void> {}
}

class FakeRuntime implements ActionRuntime {
  readonly summary = new FakeSummary();
  readonly outputs: Record<string, string> = {};

  constructor(private readonly inputs: Record<string, string>) {}

  getInput(name: string, options?: { required?: boolean }): string {
    const value = this.inputs[name] ?? "";
    if (options?.required && value === "") throw new Error(name);
    return value;
  }

  getBooleanInput(name: string): boolean {
    return this.getInput(name) === "true";
  }

  setOutput(name: string, value: unknown): void {
    this.outputs[name] = String(value);
  }

  setFailed(): void {}
  info(): void {}
  warning(): void {}
  setSecret(): void {}
  addPath(): void {}
}

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
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};

function makeDeps(mark: string): MainDependencies {
  return {
    createGitHubClient: () => fakeGh,
    createExecClient: () => fakeExec,
    runAutopilot: async () => ({
      evaluation: {
        route: "factory",
        sprint: null,
        openIssueCount: 0,
        openPrCount: 0,
        stalePrCount: 0,
        tracker: "",
        reason: mark,
        activeSprint: "none",
      },
      prCi: {
        pending: [],
        dispatched: [],
        active: [],
        current: [],
        failed: [],
      },
      decision: { holdTarget: false, targetDispatched: "executed" },
      closeOnMerge: { closed: [], skipped: [], trackerUpdated: false },
      summary: mark,
    }),
  };
}

function makeInputs(): Record<string, string> {
  return {
    "github-token": "tok",
    "dry-run": "false",
    "enable-dispatch": "false",
  };
}

describe("autopilot composition", () => {
  test("resolves the controller with fake runtime ports", async () => {
    const runtime = new FakeRuntime(makeInputs());
    const composition = createAutopilotComposition({
      runtime,
      githubContext: {
        repo: { owner: "o", repo: "r" },
        ref: "refs/heads/main",
        eventName: "workflow_dispatch",
        payload: {},
      },
      dependencies: makeDeps("first"),
    });

    const controller = composition.resolve(AutopilotActionController);
    await controller.run();

    expect(runtime.outputs.reason).toBe("first");
    expect(runtime.summary.raw).toEqual(["first"]);
  });

  test("uses a fresh fork per composition root", () => {
    const first = createAutopilotComposition({
      runtime: new FakeRuntime(makeInputs()),
      dependencies: makeDeps("first"),
    });
    const second = createAutopilotComposition({
      runtime: new FakeRuntime(makeInputs()),
      dependencies: makeDeps("second"),
    });

    expect(first.resolve(AutopilotActionController)).not.toBe(
      second.resolve(AutopilotActionController),
    );
  });
});
