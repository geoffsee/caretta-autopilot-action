import { describe, expect, test, beforeEach, mock } from "bun:test";
import type {
  AutopilotConfig,
  EvaluationResult,
  PrCiResult,
  AutopilotDecision,
} from "../src/types.js";
import type { AutopilotRunResult } from "../src/run.js";

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
}

const mockContext: GithubContext = {
  repo: { owner: "o", repo: "r" },
  ref: "refs/heads/main",
};

interface OctokitArgs {
  token: string;
  owner: string;
  repo: string;
}

const ghClientState: { lastArgs: OctokitArgs | null } = { lastArgs: null };

interface RunCall {
  config: AutopilotConfig;
  ref: string;
}

const runState: {
  calls: RunCall[];
  result: AutopilotRunResult;
  throwError: Error | null;
} = {
  calls: [],
  result: makeRunResult(),
  throwError: null,
};

function makeEvaluation(
  overrides: Partial<EvaluationResult> = {},
): EvaluationResult {
  return {
    sprint: 7,
    openIssueCount: 3,
    openPrCount: 2,
    stalePrCount: 1,
    workflow: "tracker-loop-dispatch.yml",
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
    targetDispatched: "tracker",
    targetBusy: false,
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
    addRaw(this: typeof coreState.summaryRaw extends never ? never : object, s: string) {
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

mock.module("../src/github.js", () => ({
  createOctokitClient: (token: string, owner: string, repo: string) => {
    ghClientState.lastArgs = { token, owner, repo };
    return {};
  },
}));

mock.module("../src/exec.js", () => ({
  DefaultExecClient: class {},
}));

mock.module("../src/run.js", () => ({
  runAutopilot: async (
    _gh: unknown,
    _exec: unknown,
    config: AutopilotConfig,
    ref: string,
  ) => {
    runState.calls.push({ config, ref });
    if (runState.throwError) throw runState.throwError;
    return runState.result;
  },
}));

const { main } = await import("../src/main.js");

function resetState(): void {
  coreState.inputs = {
    "github-token": "tok",
    mode: "",
    "caretta-version": "",
    agent: "",
    context: "",
    "dry-run": "false",
    "enable-dispatch": "",
    "tracker-workflow": "",
    "factory-workflow": "",
    "ci-workflow": "",
  };
  coreState.outputs = {};
  coreState.failed = undefined;
  coreState.summaryRaw = [];
  coreState.summaryWritten = false;
  mockContext.repo = { owner: "o", repo: "r" };
  mockContext.ref = "refs/heads/main";
  ghClientState.lastArgs = null;
  runState.calls = [];
  runState.result = makeRunResult();
  runState.throwError = null;
}

function lastConfig(): AutopilotConfig {
  expect(runState.calls).toHaveLength(1);
  return runState.calls[0].config;
}

describe("main: input parsing", () => {
  beforeEach(resetState);

  test.each([
    { input: "", expected: "evaluate" },
    { input: "evaluate", expected: "evaluate" },
    { input: "execute", expected: "execute" },
    { input: "garbage", expected: "evaluate" },
    { input: "EXECUTE", expected: "evaluate" },
  ])("mode '$input' → '$expected'", async ({ input, expected }) => {
    coreState.inputs.mode = input;
    await main();
    expect(lastConfig().mode).toBe(expected as AutopilotConfig["mode"]);
  });

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
      field: "trackerWorkflow" as const,
      key: "tracker-workflow",
      input: "",
      expected: "tracker-loop-dispatch.yml",
    },
    {
      field: "trackerWorkflow" as const,
      key: "tracker-workflow",
      input: "custom.yml",
      expected: "custom.yml",
    },
    {
      field: "factoryWorkflow" as const,
      key: "factory-workflow",
      input: "",
      expected: "factory-cycle-dispatch.yml",
    },
    {
      field: "factoryWorkflow" as const,
      key: "factory-workflow",
      input: "factory.yml",
      expected: "factory.yml",
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
  ])(
    "$field: input '$input' → '$expected'",
    async ({ field, key, input, expected }) => {
      coreState.inputs[key] = input;
      await main();
      expect(lastConfig()[field]).toBe(expected as never);
    },
  );

  test.each([
    { input: "", expected: true },
    { input: "true", expected: true },
    { input: "false", expected: false },
  ])(
    "enable-dispatch '$input' → $expected",
    async ({ input, expected }) => {
      coreState.inputs["enable-dispatch"] = input;
      await main();
      expect(lastConfig().enableDispatch).toBe(expected);
    },
  );

  test.each([
    { input: "true", expected: true },
    { input: "false", expected: false },
  ])("dry-run '$input' → $expected", async ({ input, expected }) => {
    coreState.inputs["dry-run"] = input;
    await main();
    expect(lastConfig().dryRun).toBe(expected);
  });

  test("missing github-token throws", async () => {
    coreState.inputs["github-token"] = "";
    await expect(main()).rejects.toThrow(/github-token/);
  });

  test("passes token+owner+repo to createOctokitClient", async () => {
    coreState.inputs["github-token"] = "tok-abc";
    mockContext.repo = { owner: "acme", repo: "widgets" };
    await main();
    expect(ghClientState.lastArgs).toEqual({
      token: "tok-abc",
      owner: "acme",
      repo: "widgets",
    });
  });

  test("default config fields (agentBranchPattern, testCheckName)", async () => {
    await main();
    const cfg = lastConfig();
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
    await main();
    expect(runState.calls[0].ref).toBe(expected);
  });
});

describe("main: output wiring", () => {
  beforeEach(resetState);

  test("sets all outputs from run result", async () => {
    runState.result = makeRunResult({
      evaluation: makeEvaluation({
        workflow: "tracker.yml",
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
    });

    await main();

    expect(coreState.outputs).toMatchObject({
      workflow: "tracker.yml",
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
  ])(
    "sprint output for evaluation.sprint=$sprint → '$expected'",
    async ({ sprint, expected }) => {
      runState.result = makeRunResult({
        evaluation: makeEvaluation({ sprint }),
      });
      await main();
      expect(coreState.outputs.sprint).toBe(expected);
    },
  );

  test.each([
    { holdTarget: true, expected: "true" },
    { holdTarget: false, expected: "false" },
  ])(
    "hold_target output for decision.holdTarget=$holdTarget",
    async ({ holdTarget, expected }) => {
      runState.result = makeRunResult({
        decision: makeDecision({ holdTarget }),
      });
      await main();
      expect(coreState.outputs.hold_target).toBe(expected);
    },
  );

  test.each([
    "tracker",
    "factory",
    "skipped",
    "executed",
  ] as const)(
    "target_dispatched output for decision='%s'",
    async (targetDispatched) => {
      runState.result = makeRunResult({
        decision: makeDecision({ targetDispatched }),
      });
      await main();
      expect(coreState.outputs.target_dispatched).toBe(targetDispatched);
    },
  );
});

describe("main: error propagation", () => {
  beforeEach(resetState);

  test("rejects when runAutopilot throws", async () => {
    runState.throwError = new Error("boom");
    await expect(main()).rejects.toThrow("boom");
    expect(coreState.outputs).toEqual({});
    expect(coreState.summaryWritten).toBe(false);
  });
});
