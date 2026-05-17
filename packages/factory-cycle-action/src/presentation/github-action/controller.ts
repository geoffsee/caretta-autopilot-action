import { Component, Container } from "di-framework/decorators";
import { ACTION_COMPONENTS } from "../../../../action-common/src/action-composition.js";
import type { ActionRuntime } from "../../../../action-common/src/action-runtime.js";
import {
  type CarettaInstallDependencies,
  CarettaRuntimePreparer,
  GitHubActionPortFactory,
  type GitHubPortDependencies,
  prepareCarettaAction,
  readCarettaRuntimeInputs,
} from "../../../../action-common/src/action-services.js";
import {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "../../../../action-common/src/caretta-install.js";
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
    @Component(ACTION_COMPONENTS.actionRuntime)
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
  const { runFactoryCycleAction } = await import("../../composition/root.js");
  await runFactoryCycleAction({ dependencies: deps });
}

async function runWithRuntime(
  runtime: ActionRuntime,
  ports: GitHubActionPortFactory,
  carettaRuntime: CarettaRuntimePreparer,
): Promise<void> {
  const carettaInputs = readCarettaRuntimeInputs(runtime);
  const agent = runtime.getInput("agent") || "claude";

  const { gh, exec, binaryPath, version, env } = await prepareCarettaAction(
    carettaInputs,
    ports,
    carettaRuntime,
  );

  const runner = new FactoryCycleRunner(binaryPath, env, exec, gh, agent);
  const result = await runner.runFactoryCycle();

  runtime.setOutput("skipped_due_to_open_sprint", String(result.skipped));
  runtime.setOutput("active_sprint", result.activeSprint);
  runtime.setOutput("caretta_version", version);
}
