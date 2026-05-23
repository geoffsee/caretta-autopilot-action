import { ACTION_COMPONENTS } from "@caretta/action-common/action-composition";
import type { ActionRuntime } from "@caretta/action-common/action-runtime";
import {
  type CarettaInstallDependencies,
  CarettaRuntimePreparer,
  GitHubActionPortFactory,
  type GitHubPortDependencies,
  prepareCarettaAction,
  readCarettaRuntimeInputs,
} from "@caretta/action-common/action-services";
import {
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
} from "@caretta/action-common/caretta-install";
import { DefaultExecClient as ProductionExecClient } from "@caretta/action-common/exec-client";
import { createOctokitClient as createProductionGitHubClient } from "@caretta/action-common/github-client";
import {
  Component as Inject,
  Container as InjectableWorkflow,
} from "di-framework/decorators";
import { FactoryCycleRunner } from "../../application/factory-cycle-runner.js";

export interface FactoryCycleDependencies
  extends GitHubPortDependencies,
    CarettaInstallDependencies {}

export const defaultFactoryCycleDependencies: FactoryCycleDependencies = {
  createGitHubClient: createProductionGitHubClient,
  createExecClient: () => new ProductionExecClient(),
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
};

@InjectableWorkflow({ singleton: false })
export class FactoryCycleWorkflow {
  constructor(
    @Inject(ACTION_COMPONENTS.actionRuntime)
    private readonly runtime: ActionRuntime,
    @Inject(GitHubActionPortFactory)
    private readonly ports: GitHubActionPortFactory,
    @Inject(CarettaRuntimePreparer)
    private readonly carettaRuntime: CarettaRuntimePreparer,
  ) {}

  async run(): Promise<void> {
    const carettaInputs = readCarettaRuntimeInputs(this.runtime);
    const agent = this.runtime.getInput("agent") || "claude";

    const { gh, exec, binaryPath, version, env } = await prepareCarettaAction(
      carettaInputs,
      this.ports,
      this.carettaRuntime,
    );

    const runner = new FactoryCycleRunner(binaryPath, env, exec, gh, agent);
    const result = await runner.runFactoryCycle();

    this.runtime.setOutput(
      "skipped_due_to_open_sprint",
      String(result.skipped),
    );
    this.runtime.setOutput("active_sprint", result.activeSprint);
    this.runtime.setOutput("caretta_version", version);
  }
}

export async function main(
  deps: FactoryCycleDependencies = defaultFactoryCycleDependencies,
): Promise<void> {
  const { runFactoryCycleAction } = await import("../../composition/root.js");
  await runFactoryCycleAction({ dependencies: deps });
}
