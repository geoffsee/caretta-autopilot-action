import * as core from "@actions/core";
import * as github from "@actions/github";
import { createOctokitClient } from "./github.js";
import { DefaultExecClient } from "./exec.js";
import { runAutopilot } from "./run.js";
import {
  DEFAULT_AGENT_BRANCH,
  DEFAULT_TEST_CHECK_NAME,
  type AutopilotConfig,
} from "./types.js";

async function main(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const modeInput = core.getInput("mode") || "evaluate";
  const mode = modeInput === "execute" ? "execute" : "evaluate";
  const carettaVersion = core.getInput("caretta-version") || "latest";
  const agent = core.getInput("agent") || "claude";
  const context =
    core.getInput("context") ||
    "Autopilot scheduled evaluation of open issues and pull requests.";
  const dryRun = core.getBooleanInput("dry-run");
  const enableDispatch =
    core.getInput("enable-dispatch") === ""
      ? true
      : core.getBooleanInput("enable-dispatch");
  const trackerWorkflow =
    core.getInput("tracker-workflow") || "tracker-loop-dispatch.yml";
  const factoryWorkflow =
    core.getInput("factory-workflow") || "factory-cycle-dispatch.yml";
  const ciWorkflow = core.getInput("ci-workflow") || "ci.yml";

  const ctx = github.context;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const ref = ctx.ref?.replace(/^refs\/heads\//, "") || "master";

  const config: AutopilotConfig = {
    mode,
    carettaVersion,
    agent,
    context,
    dryRun,
    enableDispatch,
    trackerWorkflow,
    factoryWorkflow,
    ciWorkflow,
    agentBranchPattern: DEFAULT_AGENT_BRANCH,
    testCheckName: DEFAULT_TEST_CHECK_NAME,
  };

  const gh = createOctokitClient(token, owner, repo);
  const exec = new DefaultExecClient();
  const result = await runAutopilot(gh, exec, config, ref);

  core.setOutput("workflow", result.evaluation.workflow);
  core.setOutput("tracker", result.evaluation.tracker);
  core.setOutput("sprint", result.evaluation.sprint?.toString() ?? "");
  core.setOutput("open_issue_count", String(result.evaluation.openIssueCount));
  core.setOutput("open_pr_count", String(result.evaluation.openPrCount));
  core.setOutput("stale_pr_count", String(result.evaluation.stalePrCount));
  core.setOutput("reason", result.evaluation.reason);
  core.setOutput("pending_count", String(result.prCi.pending.length));
  core.setOutput("dispatched_count", String(result.prCi.dispatched.length));
  core.setOutput("active_count", String(result.prCi.active.length));
  core.setOutput("current_count", String(result.prCi.current.length));
  core.setOutput("failed_count", String(result.prCi.failed.length));
  core.setOutput("hold_target", String(result.decision.holdTarget));
  core.setOutput("target_dispatched", result.decision.targetDispatched);

  await core.summary.addRaw(result.summary).write();
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(msg);
});
