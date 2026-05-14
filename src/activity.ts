import type { GitHubClient } from "./github.js";

export async function isWorkflowBusy(gh: GitHubClient, workflow: string): Promise<boolean> {
  const [queued, inProgress] = await Promise.all([
    gh.listWorkflowRuns(workflow, "queued"),
    gh.listWorkflowRuns(workflow, "in_progress"),
  ]);
  return queued.length > 0 || inProgress.length > 0;
}
