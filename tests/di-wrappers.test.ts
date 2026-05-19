import { describe, expect, test } from "bun:test";
import type {
  ActionRuntime,
  SummaryWriter,
} from "../packages/action-common/src/action-runtime.js";
import type {
  AutopilotConfig,
  AutopilotDecision,
  EvaluationResult,
  PrCiResult,
} from "../packages/action-common/src/types.js";
import { AutopilotUseCase } from "../src/application/run-autopilot.js";
import { createAutopilotComposition } from "../src/composition/root.js";
import {
  AutopilotDomainLogic,
  functionalAutopilotDomainModel,
} from "../src/domain/autopilot-domain.js";
import { ExecutionDecisionPolicy } from "../src/domain/decide.js";
import { EvaluationPolicy } from "../src/domain/evaluate.js";
import { SummaryPolicy } from "../src/domain/summary.js";
import { TriggerPolicy } from "../src/domain/trigger.js";
import {
  type AutopilotDependencies,
  AutopilotWorkflow,
} from "../src/presentation/github-action/controller.js";
import {
  FakeExec,
  FakeGitHub,
  makeConfig,
  makeIssue,
  makePR,
} from "./fakes.js";

const execInstallDeps = {
  installCaretta: async () => ({
    binaryPath: "/mock/caretta",
    version: "v1.0.0",
  }),
  installLinuxRuntimeDeps: async () => {},
  materializeBotPrivateKey: () => {},
  configureGitIdentity: async () => {},
};

describe("domain policy wrappers delegate to pure functions", () => {
  const prCi: PrCiResult = {
    pending: [],
    dispatched: [{ branch: "b", number: 1, sha: "s", url: "u" }],
    active: [],
    current: [],
    failed: [],
  };
  const cfg: AutopilotConfig = makeConfig();

  test("ExecutionDecisionPolicy", () => {
    const p = new ExecutionDecisionPolicy();
    expect(p.computeHoldTarget(prCi, false)).toBe(
      functionalAutopilotDomainModel.computeHoldTarget(prCi, false),
    );
    expect(p.decide(prCi, cfg)).toEqual(
      functionalAutopilotDomainModel.decideExecution(prCi, cfg),
    );
  });

  test("EvaluationPolicy", () => {
    const p = new EvaluationPolicy();
    const issues = [makeIssue({ number: 1, labels: [{ name: "sprint" }] })];
    const prs = [makePR({ number: 2 })];
    expect(p.findActiveSprint(issues)).toBe(
      functionalAutopilotDomainModel.findActiveSprint(issues),
    );
    expect(p.countStalePRs(prs)).toBe(
      functionalAutopilotDomainModel.evaluate([], prs).stalePrCount,
    );
    expect(p.evaluate(issues, prs)).toEqual(
      functionalAutopilotDomainModel.evaluate(issues, prs),
    );
  });

  test("SummaryPolicy", () => {
    const p = new SummaryPolicy();
    const evaluation: EvaluationResult = {
      route: "factory",
      sprint: null,
      openIssueCount: 0,
      openPrCount: 0,
      stalePrCount: 0,
      tracker: "",
      reason: "r",
      activeSprint: "none",
    };
    const decision: AutopilotDecision = {
      holdTarget: false,
      targetDispatched: "executed",
    };
    expect(p.build(evaluation, prCi, decision, cfg)).toBe(
      functionalAutopilotDomainModel.buildSummary(
        evaluation,
        prCi,
        decision,
        cfg,
      ),
    );
  });
});

describe("AutopilotDomainLogic", () => {
  test("mirrors functionalAutopilotDomainModel for all entrypoints", () => {
    const logic = new AutopilotDomainLogic(
      new TriggerPolicy(),
      new EvaluationPolicy(),
      new ExecutionDecisionPolicy(),
      new SummaryPolicy(),
    );
    const inputs = {
      eventName: "workflow_dispatch",
      payload: {},
      agentBranchPrefix: "agent/issue-",
    };
    expect(logic.decideTrigger(inputs)).toEqual(
      functionalAutopilotDomainModel.decideTrigger(inputs),
    );

    const issues = [makeIssue({ number: 5, labels: [{ name: "sprint" }] })];
    const prs = [makePR({ number: 9 })];
    expect(logic.findActiveSprint(issues)).toEqual(
      functionalAutopilotDomainModel.findActiveSprint(issues),
    );
    expect(logic.evaluate(issues, prs)).toEqual(
      functionalAutopilotDomainModel.evaluate(issues, prs),
    );

    const prCi: PrCiResult = {
      pending: [],
      dispatched: [],
      active: [],
      current: [],
      failed: [],
    };
    const cfg = makeConfig();
    expect(logic.computeHoldTarget(prCi, false)).toBe(
      functionalAutopilotDomainModel.computeHoldTarget(prCi, false),
    );
    expect(logic.decideExecution(prCi, cfg)).toEqual(
      functionalAutopilotDomainModel.decideExecution(prCi, cfg),
    );

    const evaluation = functionalAutopilotDomainModel.evaluate(issues, prs);
    const decision = functionalAutopilotDomainModel.decideExecution(prCi, cfg);
    expect(logic.buildSummary(evaluation, prCi, decision, cfg)).toBe(
      functionalAutopilotDomainModel.buildSummary(
        evaluation,
        prCi,
        decision,
        cfg,
      ),
    );
  });
});

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

function baseInputs(): Record<string, string> {
  return {
    "github-token": "tok",
    "dry-run": "false",
    "enable-dispatch": "false",
  };
}

describe("AutopilotUseCase", () => {
  test("run() delegates to runAutopilot with composed domain", async () => {
    const composition = createAutopilotComposition({
      runtime: new FakeRuntime(baseInputs()),
      githubContext: {
        repo: { owner: "o", repo: "r" },
        ref: "refs/heads/main",
        eventName: "workflow_dispatch",
        payload: {},
      },
      dependencies: {
        createGitHubClient: () => new FakeGitHub(),
        createExecClient: () => new FakeExec(),
      },
    });

    const useCase = composition.resolve(AutopilotUseCase);
    const exec = new FakeExec();
    const result = await useCase.run(
      new FakeGitHub(),
      exec,
      makeConfig(),
      "master",
      execInstallDeps,
    );

    expect(result.evaluation.route).toBe("factory");
    expect(exec.calls.some((c) => c.args.includes("housekeeping"))).toBe(true);
  });
});

describe("AutopilotWorkflow default runAutopilotUseCase", () => {
  test("uses injected AutopilotUseCase when deps omit runAutopilotUseCase", async () => {
    const runtime = new FakeRuntime(baseInputs());
    const deps: AutopilotDependencies = {
      createGitHubClient: () => new FakeGitHub(),
      createExecClient: () => new FakeExec(),
    };

    const composition = createAutopilotComposition({
      runtime,
      githubContext: {
        repo: { owner: "o", repo: "r" },
        ref: "refs/heads/main",
        eventName: "workflow_dispatch",
        payload: {},
      },
      dependencies: deps,
    });

    const controller = composition.resolve(AutopilotWorkflow);
    await controller.run();

    expect(runtime.outputs.route).toBe("factory");
    expect(runtime.summary.raw.length).toBeGreaterThan(0);
  });
});
