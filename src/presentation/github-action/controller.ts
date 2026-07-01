import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ACTION_COMPONENTS } from "@caretta/action-common/action-composition";
import type { ActionRuntime } from "@caretta/action-common/action-runtime";
import {
  GitHubActionPortFactory,
  type GitHubPortDependencies,
  type GithubActionContext,
} from "@caretta/action-common/action-services";
import {
  persistCodexAuthJson,
  restoreCodexAuthJson,
} from "@caretta/action-common/caretta-install";
import { DefaultExecClient as ProductionExecClient } from "@caretta/action-common/exec-client";
import { createOctokitClient as createProductionGitHubClient } from "@caretta/action-common/github-client";
import {
  type AutopilotConfig,
  DEFAULT_AGENT_BRANCH,
  DEFAULT_GEODYNAMO_URL,
} from "@caretta/action-common/types";
import {
  Component as Inject,
  Container as InjectableWorkflow,
} from "di-framework/decorators";
import {
  AutopilotUseCase,
  type RunAutopilotUseCase,
} from "../../application/run-autopilot.js";
import {
  initializeTelemetry,
  recordAutopilotComplete,
  recordAutopilotSkipped,
  recordAutopilotStart,
  recordError,
  recordEvaluationComplete,
} from "../../application/telemetry.js";
import { AutopilotDomainLogic } from "../../domain/autopilot-domain.js";

export interface AutopilotDependencies extends GitHubPortDependencies {
  readonly runAutopilotUseCase?: RunAutopilotUseCase;
}

export const defaultAutopilotDependencies: AutopilotDependencies = {
  createGitHubClient: createProductionGitHubClient,
  createExecClient: () => new ProductionExecClient(),
};

export interface AutopilotGithubActionContext extends GithubActionContext {
  readonly ref?: string;
  readonly eventName?: string;
  readonly payload?: Record<string, unknown>;
}

export async function resolveGeodynamoUrl(
  runtime: ActionRuntime,
  workspace = process.env.GITHUB_WORKSPACE || "",
): Promise<string> {
  const explicitInput = runtime.getInput("geodynamo-url").trim();
  if (explicitInput) return explicitInput;

  const configUrl = workspace
    ? await readCarettaTomlGeodynamoUrl(runtime, workspace)
    : null;
  return configUrl ?? DEFAULT_GEODYNAMO_URL;
}

async function readCarettaTomlGeodynamoUrl(
  runtime: ActionRuntime,
  workspace: string,
): Promise<string | null> {
  const configPath = join(workspace, "caretta.toml");

  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    runtime.warning(`Ignoring unreadable caretta.toml: ${errorMessage(error)}`);
    return null;
  }

  let parsed: string | null;
  try {
    parsed = readTopLevelTomlString(contents, "geodynamo_url");
  } catch (error) {
    runtime.warning(
      `Ignoring invalid caretta.toml geodynamo_url: ${errorMessage(error)}`,
    );
    return null;
  }

  if (!parsed) return null;
  try {
    return normalizeHttpUrl(parsed);
  } catch (error) {
    runtime.warning(
      `Ignoring invalid caretta.toml geodynamo_url: ${errorMessage(error)}`,
    );
    return null;
  }
}

function readTopLevelTomlString(contents: string, key: string): string | null {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (/^\[/.test(line)) return null;

    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!match || match[1] !== key) continue;
    return parseTomlStringValue(match[2].trim(), key);
  }
  return null;
}

function stripTomlComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseTomlStringValue(value: string, key: string): string {
  if (value.startsWith('"')) {
    return parseBasicTomlString(value, key);
  }
  if (value.startsWith("'")) {
    return parseLiteralTomlString(value, key);
  }
  throw new Error(`${key} must be a string`);
}

function parseBasicTomlString(value: string, key: string): string {
  let result = "";
  let escaped = false;
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (escaped) {
      result += decodeTomlEscape(ch, key);
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (value.slice(i + 1).trim()) {
        throw new Error(`${key} has trailing characters`);
      }
      return result;
    }
    result += ch;
  }
  throw new Error(`${key} has an unterminated string`);
}

function parseLiteralTomlString(value: string, key: string): string {
  const close = value.indexOf("'", 1);
  if (close < 0) throw new Error(`${key} has an unterminated string`);
  if (value.slice(close + 1).trim()) {
    throw new Error(`${key} has trailing characters`);
  }
  return value.slice(1, close);
}

function decodeTomlEscape(ch: string, key: string): string {
  switch (ch) {
    case "b":
      return "\b";
    case "t":
      return "\t";
    case "n":
      return "\n";
    case "f":
      return "\f";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    default:
      throw new Error(`${key} contains an unsupported escape`);
  }
}

function normalizeHttpUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error("must be an absolute http(s) URL");
  }
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

@InjectableWorkflow({ singleton: false })
export class AutopilotWorkflow {
  constructor(
    @Inject(ACTION_COMPONENTS.actionRuntime)
    private readonly runtime: ActionRuntime,
    @Inject(ACTION_COMPONENTS.githubContext)
    private readonly githubContext: AutopilotGithubActionContext,
    @Inject(ACTION_COMPONENTS.mainDependencies)
    private readonly deps: AutopilotDependencies,
    @Inject(GitHubActionPortFactory)
    private readonly ports: GitHubActionPortFactory,
    @Inject(AutopilotDomainLogic)
    private readonly domain: AutopilotDomainLogic,
    @Inject(AutopilotUseCase)
    private readonly autopilotUseCase: AutopilotUseCase,
  ) {}

  async run(): Promise<void> {
    const startTime = Date.now();
    const token = this.runtime.getInput("github-token", { required: true });
    const carettaVersion = this.runtime.getInput("caretta-version") || "latest";
    const agent = this.runtime.getInput("agent") || "claude";
    const context =
      this.runtime.getInput("context") ||
      "Autopilot scheduled evaluation of open issues and pull requests.";
    const geodynamoUrl = await resolveGeodynamoUrl(this.runtime);
    const dryRun = this.runtime.getBooleanInput("dry-run");
    const enableDispatch =
      this.runtime.getInput("enable-dispatch") === ""
        ? true
        : this.runtime.getBooleanInput("enable-dispatch");
    const ciWorkflow = this.runtime.getInput("ci-workflow") || "ci.yml";
    const testCheckName = this.runtime.getInput("test-check-name") || "Test";
    const gitUserName =
      this.runtime.getInput("git-user-name") || "caretta-autopilot[bot]";
    const gitUserEmail =
      this.runtime.getInput("git-user-email") ||
      "caretta-autopilot[bot]@users.noreply.github.com";

    const repository = `${this.githubContext.repo.owner}/${this.githubContext.repo.repo}`;
    const ref =
      this.githubContext.ref?.replace(/^refs\/heads\//, "") || "master";
    const trigger = this.domain.decideTrigger({
      eventName: this.githubContext.eventName ?? "",
      payload: (this.githubContext.payload ?? {}) as Record<string, unknown>,
      agentBranchPrefix: "agent/issue-",
    });

    if (!trigger.run) {
      this.runtime.info(`autopilot: skipping (${trigger.reason})`);
      await this.runtime.summary
        .addRaw(`### Autopilot skipped\n\n_${trigger.reason}_\n`)
        .write();
      recordAutopilotSkipped(repository, trigger.reason);
      return;
    }
    this.runtime.info(`autopilot: running (${trigger.reason})`);
    recordAutopilotStart(repository);

    const config: AutopilotConfig = {
      carettaVersion,
      agent,
      context,
      repository: `${this.githubContext.repo.owner}/${this.githubContext.repo.repo}`,
      geodynamoUrl,
      dryRun,
      enableDispatch,
      ciWorkflow,
      agentBranchPattern: DEFAULT_AGENT_BRANCH,
      testCheckName,
      githubToken: token,
      gitUserName,
      gitUserEmail,
    };

    const env = process.env as Record<string, string>;
    const codexAuthManaged = agent === "codex" && restoreCodexAuthJson(env);

    const { gh, exec } = this.ports.create(token);
    const runAutopilotUseCase: RunAutopilotUseCase =
      this.deps.runAutopilotUseCase ??
      ((gh, exec, config, ref) =>
        this.autopilotUseCase.run(gh, exec, config, ref));

    let result: Awaited<ReturnType<RunAutopilotUseCase>>;
    try {
      result = await runAutopilotUseCase(gh, exec, config, ref);
    } finally {
      if (codexAuthManaged) {
        await persistCodexAuthJson(env);
      }
    }

    // Record evaluation telemetry
    recordEvaluationComplete(
      repository,
      result.evaluation.openIssueCount,
      result.evaluation.openPrCount,
      result.evaluation.stalePrCount,
    );

    this.runtime.setOutput("route", result.evaluation.route);
    this.runtime.setOutput("tracker", result.evaluation.tracker);
    this.runtime.setOutput(
      "sprint",
      result.evaluation.sprint?.toString() ?? "",
    );
    this.runtime.setOutput(
      "open_issue_count",
      String(result.evaluation.openIssueCount),
    );
    this.runtime.setOutput(
      "open_pr_count",
      String(result.evaluation.openPrCount),
    );
    this.runtime.setOutput(
      "stale_pr_count",
      String(result.evaluation.stalePrCount),
    );
    this.runtime.setOutput("reason", result.evaluation.reason);
    this.runtime.setOutput("pending_count", String(result.prCi.pending.length));
    this.runtime.setOutput(
      "dispatched_count",
      String(result.prCi.dispatched.length),
    );
    this.runtime.setOutput("active_count", String(result.prCi.active.length));
    this.runtime.setOutput("current_count", String(result.prCi.current.length));
    this.runtime.setOutput("failed_count", String(result.prCi.failed.length));
    this.runtime.setOutput("hold_target", String(result.decision.holdTarget));
    this.runtime.setOutput(
      "target_dispatched",
      result.decision.targetDispatched,
    );

    // Record completion telemetry
    const durationMs = Date.now() - startTime;
    recordAutopilotComplete(
      repository,
      durationMs,
      result.evaluation.openIssueCount,
      result.evaluation.openPrCount,
      result.prCi.dispatched.length,
    );

    await this.runtime.summary.addRaw(result.summary).write();
  }
}

export async function main(
  deps: AutopilotDependencies = defaultAutopilotDependencies,
): Promise<void> {
  // Initialize telemetry for anonymous usage data collection
  // URL and app ID are hardcoded for IP protection
  initializeTelemetry();

  const { runAutopilotAction } = await import("../../composition/root.js");
  await runAutopilotAction({ dependencies: deps });
}
