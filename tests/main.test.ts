import { beforeEach, describe, expect, mock, test } from "bun:test";
import { DefaultExecClient, type ExecClient } from "../src/exec.js";
import { createOctokitClient, type GitHubClient } from "../src/github.js";
import { type AutopilotRunResult, runAutopilot } from "../src/run.js";
import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  PrCiResult,
} from "../src/types.js";

interface CoreState {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  failed: string | undefined;
  summaryRaw: string[];
  summaryWritten: boolean;
}

const coreState: CoreState = {
  inputs: {},
  outputs: {},
  failed: undefined,
  summaryRaw: [],
  summaryWritten: false,
};

interface GithubContext {
  repo: { owner: string; repo: string };
  ref: string | undefined;
  eventName: string;
  payload: Record<string, unknown>;
}

const mockContext: GithubContext = {
  repo: { owner: "o", repo: "r" },
  ref: "refs/heads/main",
  eventName: "workflow_dispatch",
  payload: {},
};

mock.module("@actions/core", () => ({
  getInput: (name: string, opts?: { required?: boolean }) => {
    const v = coreState.inputs[name] ?? "";
    if (opts?.required && v === "") {
      throw new Error(`Input required and not supplied: ${name}`);
    }
    return v;
  },
  getBooleanInput: (name: string) => {
    const raw = coreState.inputs[name] ?? "";
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new TypeError(
      `Input does not meet YAML 1.2 "Core Schema" specification: ${name}`,
    );
  },
  setOutput: (name: string, value: unknown) => {
    coreState.outputs[name] = String(value);
  },
  setFailed: (msg: string) => {
    coreState.failed = msg;
  },
  setSecret: () => {},
  info: () => {},
  warning: () => {},
  summary: {
    addRaw(s: string) {
      coreState.summaryRaw.push(s);
      return {
        async write() {
          coreState.summaryWritten = true;
        },
      };
    },
  },
}));

mock.module("@actions/github", () => ({
  context: mockContext,
}));

const { main, defaultDependencies } = await import("../src/main.js");

function makeEvaluation(
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

function makePrCi(overrides: Partial<PrCiResult> = {}): PrCiResult {
  return {
    pending: [],
    dispatched: [],
    active: [],
    current: [],
    failed: [],
    ...overrides,
  };
}

function makeDecision(
  overrides: Partial<AutopilotDecision> = {},
): AutopilotDecision {
  return {
    holdTarget: false,
    targetDispatched: "executed",
    ...overrides,
  };
}

function makeRunResult(
  overrides: Partial<AutopilotRunResult> = {},
): AutopilotRunResult {
  return {
    evaluation: makeEvaluation(),
    prCi: makePrCi(),
    decision: makeDecision(),
    summary: "summary text",
    ...overrides,
  };
}

interface RunCall {
  config: AutopilotConfig;
  ref: string;
}

interface Harness {
  runCalls: RunCall[];
  ghClientArgs: { token: string; owner: string; repo: string } | null;
  deps: Parameters<typeof main>[0];
}

function makeHarness(
  options: { result?: AutopilotRunResult; throwError?: Error } = {},
): Harness {
  const runCalls: RunCall[] = [];
  let ghClientArgs: Harness["ghClientArgs"] = null;
  const fakeGh: GitHubClient = {
    async listOpenIssues() {
      return [];
    },
    async listOpenPullRequests() {
      return [];
    },
    async listWorkflowRuns() {
      return [];
    },
    async listCheckRuns() {
      return [];
    },
    async dispatchWorkflow() {},
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
    get ghClientArgs() {
      return ghClientArgs;
    },
    deps: {
      createGitHubClient: (token, owner, repo) => {
        ghClientArgs = { token, owner, repo };
        return fakeGh;
      },
      createExecClient: () => fakeExec,
      runAutopilot: async (_gh, _exec, config, ref) => {
        runCalls.push({ config, ref });
        if (options.throwError) throw options.throwError;
        return options.result ?? makeRunResult();
      },
    },
  };
}

function baseInputs(): Record<string, string> {
  return {
    "github-token": "tok",
    "caretta-version": "",
    agent: "",
    context: "",
    "dry-run": "false",
    "enable-dispatch": "",
    "ci-workflow": "",
  };
}

function resetState(): void {
  coreState.inputs = baseInputs();
  coreState.outputs = {};
  coreState.failed = undefined;
  coreState.summaryRaw = [];
  coreState.summaryWritten = false;
  mockContext.repo = { owner: "o", repo: "r" };
  mockContext.ref = "refs/heads/main";
  mockContext.eventName = "workflow_dispatch";
  mockContext.payload = {};
}

describe("main: event gate", () => {
  beforeEach(resetState);

  test("skips on irrelevant event without invoking runAutopilot", async () => {
    mockContext.eventName = "issues";
    mockContext.payload = {
      action: "opened",
      issue: { labels: [{ name: "bug" }] },
    };
    const h = makeHarness();
    await main(h.deps);
    expect(h.runCalls).toHaveLength(0);
    expect(coreState.summaryWritten).toBe(true);
    expect(coreState.summaryRaw.join("")).toContain("Autopilot skipped");
  });

  test("runs on sprint-labeled issue", async () => {
    mockContext.eventName = "issues";
    mockContext.payload = {
      action: "labeled",
      issue: { labels: [{ name: "sprint" }] },
    };
    const h = makeHarness();
    await main(h.deps);
    expect(h.runCalls).toHaveLength(1);
  });

  test("runs on agent PR event", async () => {
    mockContext.eventName = "pull_request";
    mockContext.payload = {
      action: "closed",
      pull_request: { head: { ref: "agent/issue-12" } },
    };
    const h = makeHarness();
    await main(h.deps);
    expect(h.runCalls).toHaveLength(1);
  });

  test("skips on non-agent workflow_run", async () => {
    mockContext.eventName = "workflow_run";
    mockContext.payload = {
      workflow_run: { head_branch: "main", conclusion: "success" },
    };
    const h = makeHarness();
    await main(h.deps);
    expect(h.runCalls).toHaveLength(0);
  });
});

describe("main: input parsing", () => {
  beforeEach(resetState);

  test.each([
    {
      field: "carettaVersion" as const,
      key: "caretta-version",
      input: "",
      expected: "latest",
    },
    {
      field: "carettaVersion" as const,
      key: "caretta-version",
      input: "v2.0.0",
      expected: "v2.0.0",
    },
    { field: "agent" as const, key: "agent", input: "", expected: "claude" },
    {
      field: "agent" as const,
      key: "agent",
      input: "gemini",
      expected: "gemini",
    },
    {
      field: "context" as const,
      key: "context",
      input: "",
      expected:
        "Autopilot scheduled evaluation of open issues and pull requests.",
    },
    {
      field: "context" as const,
      key: "context",
      input: "ship it",
      expected: "ship it",
    },
    {
      field: "ciWorkflow" as const,
      key: "ci-workflow",
      input: "",
      expected: "ci.yml",
    },
    {
      field: "ciWorkflow" as const,
      key: "ci-workflow",
      input: "tests.yml",
      expected: "tests.yml",
    },
  ])("$field: input '$input' → '$expected'", async ({
    field,
    key,
    input,
    expected,
  }) => {
    coreState.inputs[key] = input;
    const h = makeHarness();
    await main(h.deps);
    expect(h.runCalls[0].config[field]).toBe(expected as never);
  });

  test.each([
    { input: "", expected: true },
    { input: "true", expected: true },
    { input: "false", expected: false },
  ])("enable-dispatch '$input' → $expected", async ({ input, expected }) => {
    coreState.inputs["enable-dispatch"] = input;
    const h = makeHarness();
    await main(h.deps);
    expect(h.runCalls[0].config.enableDispatch).toBe(expected);
  });

  test.each([
    { input: "true", expected: true },
    { input: "false", expected: false },
  ])("dry-run '$input' → $expected", async ({ input, expected }) => {
    coreState.inputs["dry-run"] = input;
    const h = makeHarness();
    await main(h.deps);
    expect(h.runCalls[0].config.dryRun).toBe(expected);
  });

  test("missing github-token throws", async () => {
    coreState.inputs["github-token"] = "";
    const h = makeHarness();
    await expect(main(h.deps)).rejects.toThrow(/github-token/);
  });

  test("passes token+owner+repo to createGitHubClient", async () => {
    coreState.inputs["github-token"] = "tok-abc";
    mockContext.repo = { owner: "acme", repo: "widgets" };
    const h = makeHarness();
    await main(h.deps);
    expect(h.ghClientArgs).toEqual({
      token: "tok-abc",
      owner: "acme",
      repo: "widgets",
    });
  });

  test("default config fields (agentBranchPattern, testCheckName)", async () => {
    const h = makeHarness();
    await main(h.deps);
    const cfg = h.runCalls[0].config;
    expect(cfg.agentBranchPattern).toBeInstanceOf(RegExp);
    expect(cfg.agentBranchPattern.test("agent/issue-42")).toBe(true);
    expect(cfg.agentBranchPattern.test("main")).toBe(false);
    expect(cfg.testCheckName).toBe("Test");
  });
});

describe("main: ref handling", () => {
  beforeEach(resetState);

  test.each([
    { ref: "refs/heads/main", expected: "main" },
    { ref: "refs/heads/feature/x", expected: "feature/x" },
    { ref: "refs/tags/v1.0", expected: "refs/tags/v1.0" },
    { ref: "main", expected: "main" },
    { ref: "", expected: "master" },
    { ref: undefined, expected: "master" },
  ])("ref '$ref' → '$expected'", async ({ ref, expected }) => {
    mockContext.ref = ref;
    const h = makeHarness();
    await main(h.deps);
    expect(h.runCalls[0].ref).toBe(expected);
  });
});

describe("main: output wiring", () => {
  beforeEach(resetState);

  test("sets all outputs from run result", async () => {
    const h = makeHarness({
      result: makeRunResult({
        evaluation: makeEvaluation({
          route: "work",
          tracker: "9",
          sprint: 9,
          openIssueCount: 4,
          openPrCount: 2,
          stalePrCount: 1,
          reason: "because",
        }),
        prCi: makePrCi({
          pending: [{ number: 1, branch: "b", sha: "s", url: "u" }],
          dispatched: [
            { number: 2, branch: "b", sha: "s", url: "u" },
            { number: 3, branch: "b", sha: "s", url: "u" },
          ],
          active: [{ number: 4, branch: "b", sha: "s", url: "u" }],
          current: [],
          failed: [{ number: 5, branch: "b", sha: "s", url: "u" }],
        }),
        decision: makeDecision({
          holdTarget: true,
          targetDispatched: "skipped",
        }),
        summary: "## hello",
      }),
    });

    await main(h.deps);

    expect(coreState.outputs).toMatchObject({
      route: "work",
      tracker: "9",
      sprint: "9",
      open_issue_count: "4",
      open_pr_count: "2",
      stale_pr_count: "1",
      reason: "because",
      pending_count: "1",
      dispatched_count: "2",
      active_count: "1",
      current_count: "0",
      failed_count: "1",
      hold_target: "true",
      target_dispatched: "skipped",
    });
    expect(coreState.summaryRaw).toEqual(["## hello"]);
    expect(coreState.summaryWritten).toBe(true);
  });

  test.each([
    { sprint: null, expected: "" },
    { sprint: 0, expected: "0" },
    { sprint: 42, expected: "42" },
  ])("sprint output for evaluation.sprint=$sprint → '$expected'", async ({
    sprint,
    expected,
  }) => {
    const h = makeHarness({
      result: makeRunResult({ evaluation: makeEvaluation({ sprint }) }),
    });
    await main(h.deps);
    expect(coreState.outputs.sprint).toBe(expected);
  });

  test.each([
    { holdTarget: true, expected: "true" },
    { holdTarget: false, expected: "false" },
  ])("hold_target output for decision.holdTarget=$holdTarget", async ({
    holdTarget,
    expected,
  }) => {
    const h = makeHarness({
      result: makeRunResult({ decision: makeDecision({ holdTarget }) }),
    });
    await main(h.deps);
    expect(coreState.outputs.hold_target).toBe(expected);
  });

  test.each(["executed", "skipped"] as const)(
    "target_dispatched output for decision='%s'",
    async (targetDispatched) => {
      const h = makeHarness({
        result: makeRunResult({
          decision: makeDecision({ targetDispatched }),
        }),
      });
      await main(h.deps);
      expect(coreState.outputs.target_dispatched).toBe(targetDispatched);
    },
  );
});

describe("main: error propagation", () => {
  beforeEach(resetState);

  test("rejects when runAutopilot throws", async () => {
    const h = makeHarness({ throwError: new Error("boom") });
    await expect(main(h.deps)).rejects.toThrow("boom");
    expect(coreState.outputs).toEqual({});
    expect(coreState.summaryWritten).toBe(false);
  });
});

describe("defaultDependencies", () => {
  test("createGitHubClient delegates to createOctokitClient", () => {
    expect(defaultDependencies.createGitHubClient).toBe(createOctokitClient);
  });

  test("createExecClient returns a DefaultExecClient", () => {
    expect(defaultDependencies.createExecClient()).toBeInstanceOf(
      DefaultExecClient,
    );
  });

  test("runAutopilot is the real implementation", () => {
    expect(defaultDependencies.runAutopilot).toBe(runAutopilot);
  });
});
