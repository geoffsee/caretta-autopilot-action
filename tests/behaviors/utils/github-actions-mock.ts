import { mock } from "bun:test";

/** Captured @actions/core surface used by `behavior-suite` contract tests. */
export interface CoreCapture {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  failed: string | undefined;
  summaryRaw: string[];
  summaryWritten: boolean;
}

export const coreCapture: CoreCapture = {
  inputs: {},
  outputs: {},
  failed: undefined,
  summaryRaw: [],
  summaryWritten: false,
};

export interface GithubContextShape {
  repo: { owner: string; repo: string };
  ref: string | undefined;
  eventName: string;
  payload: Record<string, unknown>;
}

export const mockGithubContext: GithubContextShape = {
  repo: { owner: "o", repo: "r" },
  ref: "refs/heads/main",
  eventName: "workflow_dispatch",
  payload: {},
};

let mocksInstalled = false;

/** Idempotent: registers `@actions/core` and `@actions/github` mocks. */
export function installGithubActionsMocks(): void {
  if (mocksInstalled) return;
  mocksInstalled = true;

  mock.module("@actions/core", () => ({
    getInput: (name: string, opts?: { required?: boolean }) => {
      const v = coreCapture.inputs[name] ?? "";
      if (opts?.required && v === "") {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return v;
    },
    getBooleanInput: (name: string) => {
      const raw = coreCapture.inputs[name] ?? "";
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new TypeError(
        `Input does not meet YAML 1.2 "Core Schema" specification: ${name}`,
      );
    },
    setOutput: (name: string, value: unknown) => {
      coreCapture.outputs[name] = String(value);
    },
    setFailed: (msg: string) => {
      coreCapture.failed = msg;
    },
    setSecret: () => {},
    info: () => {},
    warning: () => {},
    summary: {
      addRaw(s: string) {
        coreCapture.summaryRaw.push(s);
        return {
          async write() {
            coreCapture.summaryWritten = true;
          },
        };
      },
    },
  }));

  mock.module("@actions/github", () => ({
    context: mockGithubContext,
  }));
}

export function baseInputs(): Record<string, string> {
  return {
    "github-token": "tok",
    "caretta-version": "",
    agent: "",
    context: "",
    "dry-run": "false",
    "enable-dispatch": "",
    "ci-workflow": "",
    "git-user-name": "",
    "git-user-email": "",
  };
}

export function resetGithubActionsCapture(): void {
  coreCapture.inputs = baseInputs();
  coreCapture.outputs = {};
  coreCapture.failed = undefined;
  coreCapture.summaryRaw = [];
  coreCapture.summaryWritten = false;
  mockGithubContext.repo = { owner: "o", repo: "r" };
  mockGithubContext.ref = "refs/heads/main";
  mockGithubContext.eventName = "workflow_dispatch";
  mockGithubContext.payload = {};
}
