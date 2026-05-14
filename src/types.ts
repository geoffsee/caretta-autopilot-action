export interface Label {
  name: string;
}

export interface Issue {
  number: number;
  title: string;
  labels: Label[];
  updatedAt: string;
  url: string;
}

export interface PullRequest {
  number: number;
  title: string;
  isDraft: boolean;
  reviewDecision: string | null;
  updatedAt: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  mergeStateStatus: string;
}

export interface CheckRun {
  name: string;
  startedAt: string | null;
  createdAt: string | null;
}

export interface WorkflowRun {
  id: number;
  headSha: string;
  status: string;
}

export interface PrEntry {
  number: number;
  branch: string;
  sha: string;
  url: string;
}

export interface EvaluationResult {
  sprint: number | null;
  openIssueCount: number;
  openPrCount: number;
  stalePrCount: number;
  workflow: string;
  tracker: string;
  reason: string;
  activeSprint: string;
}

export interface PrCiResult {
  pending: PrEntry[];
  dispatched: PrEntry[];
  active: PrEntry[];
  current: PrEntry[];
  failed: PrEntry[];
}

export interface AutopilotDecision {
  holdTarget: boolean;
  targetDispatched: "tracker" | "factory" | "skipped" | "executed";
  targetBusy: boolean;
}

export interface AutopilotConfig {
  mode: "evaluate" | "execute";
  carettaVersion: string;
  agent: string;
  context: string;
  dryRun: boolean;
  enableDispatch: boolean;
  trackerWorkflow: string;
  factoryWorkflow: string;
  ciWorkflow: string;
  agentBranchPattern: RegExp;
  testCheckName: string;
}

export const DEFAULT_AGENT_BRANCH = /^agent\/issue-[0-9]+$/;
export const DEFAULT_TEST_CHECK_NAME = "Test";
