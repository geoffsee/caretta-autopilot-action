import type { ExecClient } from "../../../packages/action-common/src/exec-client.js";
import type { GitHubClient } from "../../../packages/action-common/src/github-client.js";
import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  PrCiResult,
} from "../../../packages/action-common/src/types.js";
import type { AutopilotRunResult } from "../../../src/application/run-autopilot.js";
import type { AutopilotDependencies } from "../../../src/presentation/github-action/controller.js";

export function makeEvaluation(
  overrides: Partial<EvaluationResult> = {},
): EvaluationResult {
  return {
    route: "work",
    sprint: 7,
    openIssueCount: 3,
    openPrCount: 2,
    stalePrCount: 1,
    tracker: "7",
    reason: "open sprint #7",
    activeSprint: "#7",
    ...overrides,
  };
}

export function makePrCi(overrides: Partial<PrCiResult> = {}): PrCiResult {
  return {
    pending: [],
    dispatched: [],
    active: [],
    current: [],
    failed: [],
    ...overrides,
  };
}

export function makeDecision(
  overrides: Partial<AutopilotDecision> = {},
): AutopilotDecision {
  return {
    holdTarget: false,
    targetDispatched: "executed",
    ...overrides,
  };
}

export function makeRunResult(
  overrides: Partial<AutopilotRunResult> = {},
): AutopilotRunResult {
  return {
    evaluation: makeEvaluation(),
    prCi: makePrCi(),
    decision: makeDecision(),
    closeOnMerge: {
      closed: [],
      skipped: [],
      trackerUpdated: false,
      trackerCompleted: false,
    },
    summary: "summary text",
    ...overrides,
  };
}

export interface RunCall {
  config: AutopilotConfig;
  ref: string;
}

export interface MainHarness {
  runCalls: RunCall[];
  deps: AutopilotDependencies;
}

export function makeMainHarness(
  options: { result?: AutopilotRunResult; throwError?: Error } = {},
): MainHarness {
  const runCalls: RunCall[] = [];
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
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return {
    runCalls,
    deps: {
      createGitHubClient: () => fakeGh,
      createExecClient: () => fakeExec,
      runAutopilotUseCase: async (_gh, _exec, config, ref) => {
        runCalls.push({ config, ref });
        if (options.throwError) throw options.throwError;
        return options.result ?? makeRunResult();
      },
    },
  };
}
