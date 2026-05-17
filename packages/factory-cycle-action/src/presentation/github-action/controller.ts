import { Component, Container } from "di-framework/decorators";
import type { ActionRuntime } from "../../../../action-common/src/action-runtime.js";
import {
  type CarettaInstallDependencies,
  CarettaRuntimePreparer,
  GitHubActionPortFactory,
  type GitHubPortDependencies,
} from "../../../../action-common/src/action-services.js";
import {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "../../../../action-common/src/caretta-install.js";
import { ACTION_TOKENS } from "../../../../action-common/src/di-container.js";
import { DefaultExecClient } from "../../../../action-common/src/exec-client.js";
import { createOctokitClient } from "../../../../action-common/src/github-client.js";
import { FactoryCycleRunner } from "../../application/factory-cycle-runner.js";

export interface FactoryCycleMainDeps
  extends GitHubPortDependencies,
    CarettaInstallDependencies {}

export const defaultFactoryCycleMainDeps: FactoryCycleMainDeps = {
  createGitHubClient: createOctokitClient,
  createExecClient: () => new DefaultExecClient(),
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
};

@Container({ singleton: false })
export class FactoryCycleActionController {
  constructor(
    @Component(ACTION_TOKENS.actionRuntime)
    private readonly runtime: ActionRuntime,
    @Component(GitHubActionPortFactory)
    private readonly ports: GitHubActionPortFactory,
    @Component(CarettaRuntimePreparer)
    private readonly carettaRuntime: CarettaRuntimePreparer,
  ) {}

  async run(): Promise<void> {
    await runWithRuntime(this.runtime, this.ports, this.carettaRuntime);
  }
}

export async function main(
  deps: FactoryCycleMainDeps = defaultFactoryCycleMainDeps,
): Promise<void> {
  const { runFactoryCycleAction } = await import(
    "../../composition/container.js"
  );
  await runFactoryCycleAction({ dependencies: deps });
}

async function runWithRuntime(
  runtime: ActionRuntime,
  ports: GitHubActionPortFactory,
  carettaRuntime: CarettaRuntimePreparer,
): Promise<void> {
  const token = runtime.getInput("github-token", { required: true });
  const context = runtime.getInput("context") || "";
  const model = runtime.getInput("model") || "";
  const carettaVersion = runtime.getInput("caretta-version") || "latest";
  const agent = runtime.getInput("agent") || "claude";

  const { gh, exec } = ports.create(token);
  const { binaryPath, version, env } = await carettaRuntime.prepare({
    token,
    carettaVersion,
    context,
    model,
  });

  const runner = new FactoryCycleRunner(binaryPath, env, exec, gh, agent);
  const result = await runner.runFactoryCycle();

  runtime.setOutput("skipped_due_to_open_sprint", String(result.skipped));
  runtime.setOutput("active_sprint", result.activeSprint);
  runtime.setOutput("caretta_version", version);
}
