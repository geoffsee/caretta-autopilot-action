import { Component, Container } from "di-framework/decorators";
import { ACTION_TOKENS } from "./di-container.js";
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

@Container({ singleton: false })
export class GitHubActionPortFactory {
  constructor(
    @Component(ACTION_TOKENS.githubContext)
    private readonly githubContext: GithubActionContext,
    @Component(ACTION_TOKENS.mainDependencies)
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

@Container({ singleton: false })
export class CarettaRuntimePreparer {
  constructor(
    @Component(ACTION_TOKENS.mainDependencies)
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
