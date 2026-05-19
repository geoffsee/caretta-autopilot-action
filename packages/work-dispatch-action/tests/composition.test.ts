import { describe, expect, test } from "bun:test";
import type {
  ActionRuntime,
  SummaryWriter,
} from "../../action-common/src/action-runtime.js";
import type { ExecClient } from "../../action-common/src/exec-client.js";
import type { GitHubClient } from "../../action-common/src/github-client.js";
import {
  createWorkDispatchComposition,
  runWorkDispatchAction,
} from "../src/composition/root.js";
import {
  type TrackerLoopDependencies,
  TrackerLoopWorkflow,
} from "../src/presentation/github-action/controller.js";

class FakeSummary implements SummaryWriter {
  addRaw(): SummaryWriter {
    return this;
  }
  async write(): Promise<void> {}
}

class FakeRuntime implements ActionRuntime {
  readonly summary = new FakeSummary();
  readonly outputs: Record<string, string> = {};

  getInput(name: string): string {
    return (
      {
        "github-token": "tok",
        tracker: "7",
        "ci-timeout-minutes": "1",
      }[name] ?? ""
    );
  }

  getBooleanInput(): boolean {
    return false;
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

const deps: TrackerLoopDependencies = {
  createGitHubClient: () => fakeGh,
  createExecClient: () => fakeExec,
  installCaretta: async () => ({ binaryPath: "/tmp/caretta", version: "v1" }),
  installLinuxRuntimeDeps: async () => {},
  materializeBotPrivateKey: () => {},
};

describe("work-dispatch composition", () => {
  test("resolves the controller with fake ports", async () => {
    const runtime = new FakeRuntime();
    const composition = createWorkDispatchComposition({
      runtime,
      githubContext: { repo: { owner: "o", repo: "r" } },
      dependencies: deps,
    });

    await composition.resolve(TrackerLoopWorkflow).run();

    expect(runtime.outputs.tracker).toBe("7");
    expect(runtime.outputs.caretta_version).toBe("v1");
  });

  test("runWorkDispatchAction runs the composed workflow", async () => {
    const runtime = new FakeRuntime();
    await runWorkDispatchAction({
      runtime,
      githubContext: { repo: { owner: "o", repo: "r" } },
      dependencies: deps,
    });
    expect(runtime.outputs.tracker).toBe("7");
    expect(runtime.outputs.caretta_version).toBe("v1");
  });

  test("does not carry controller singletons between forks", () => {
    const first = createWorkDispatchComposition({
      runtime: new FakeRuntime(),
      dependencies: deps,
    });
    const second = createWorkDispatchComposition({
      runtime: new FakeRuntime(),
      dependencies: deps,
    });

    expect(first.resolve(TrackerLoopWorkflow)).not.toBe(
      second.resolve(TrackerLoopWorkflow),
    );
  });
});
