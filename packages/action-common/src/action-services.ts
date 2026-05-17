import {
  Component as Inject,
  Container as InjectableService,
} from "di-framework/decorators";
import { ACTION_COMPONENTS } from "./action-composition.js";
import type { ActionRuntime } from "./action-runtime.js";
import type { ExecClient } from "./exec-client.js";
import type { GitHubClient } from "./github-client.js";

export interface GithubActionContext {
  readonly repo: { owner: string; repo: string };
}

export interface GitHubPortDependencies {
  readonly createGitHubClient: (
    token: string,
    owner: string,
    repo: string,
  ) => GitHubClient;
  readonly createExecClient: () => ExecClient;
}

export interface GitHubActionPorts {
  readonly gh: GitHubClient;
  readonly exec: ExecClient;
}

@InjectableService({ singleton: false })
export class GitHubActionPortFactory {
  constructor(
    @Inject(ACTION_COMPONENTS.githubContext)
    private readonly githubContext: GithubActionContext,
    @Inject(ACTION_COMPONENTS.mainDependencies)
    private readonly deps: GitHubPortDependencies,
  ) {}

  create(token: string): GitHubActionPorts {
    const { owner, repo } = this.githubContext.repo;
    return {
      gh: this.deps.createGitHubClient(token, owner, repo),
      exec: this.deps.createExecClient(),
    };
  }
}

export interface CarettaInstallDependencies {
  readonly installCaretta: (
    versionInput: string,
    token: string,
  ) => Promise<{ binaryPath: string; version: string }>;
  readonly installLinuxRuntimeDeps: () => Promise<void>;
  readonly materializeBotPrivateKey: (env: Record<string, string>) => void;
}

export interface CarettaRuntimeInputs {
  readonly token: string;
  readonly carettaVersion: string;
  readonly context?: string;
  readonly model?: string;
}

export interface PreparedCarettaRuntime {
  readonly binaryPath: string;
  readonly version: string;
  readonly env: Record<string, string>;
}

export interface PreparedCarettaAction extends PreparedCarettaRuntime {
  readonly token: string;
  readonly gh: GitHubClient;
  readonly exec: ExecClient;
}

@InjectableService({ singleton: false })
export class CarettaRuntimePreparer {
  constructor(
    @Inject(ACTION_COMPONENTS.mainDependencies)
    private readonly deps: CarettaInstallDependencies,
  ) {}

  async prepare(inputs: CarettaRuntimeInputs): Promise<PreparedCarettaRuntime> {
    const { binaryPath, version } = await this.deps.installCaretta(
      inputs.carettaVersion,
      process.env.GITHUB_TOKEN || inputs.token,
    );
    await this.deps.installLinuxRuntimeDeps();

    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    if (!env.GH_TOKEN) {
      env.GH_TOKEN = inputs.token || process.env.GITHUB_TOKEN || "";
    }
    if (!env.RUST_LOG) env.RUST_LOG = "info";
    if (inputs.context) env.CARETTA_CONTEXT = inputs.context;
    if (inputs.model) env.CARETTA_MODEL = inputs.model;
    this.deps.materializeBotPrivateKey(env);

    return { binaryPath, version, env };
  }
}

export function readCarettaRuntimeInputs(
  runtime: ActionRuntime,
): CarettaRuntimeInputs {
  return {
    token: runtime.getInput("github-token", { required: true }),
    context: runtime.getInput("context") || "",
    model: runtime.getInput("model") || "",
    carettaVersion: runtime.getInput("caretta-version") || "latest",
  };
}

export async function prepareCarettaAction(
  inputs: CarettaRuntimeInputs,
  ports: GitHubActionPortFactory,
  carettaRuntime: CarettaRuntimePreparer,
): Promise<PreparedCarettaAction> {
  const { gh, exec } = ports.create(inputs.token);
  const prepared = await carettaRuntime.prepare(inputs);

  return { token: inputs.token, gh, exec, ...prepared };
}
