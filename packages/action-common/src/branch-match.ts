export const DEFAULT_AGENT_BRANCH = /^agent\/issue-[0-9]+(?:-.*)?$/;
export const DEFAULT_AGENT_BRANCH_PREFIX = "agent/issue-";

export function agentIssueNumber(branch: string): number | null {
  const match = branch.match(/^agent\/issue-([0-9]+)(?:-.*)?$/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function isAgentBranch(
  branch: string,
  pattern = DEFAULT_AGENT_BRANCH,
): boolean {
  return pattern.test(branch);
}
