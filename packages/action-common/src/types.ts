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
  isAutoMergeEnabled: boolean;
}

export interface PullRequestReview {
  state: string;
  body: string;
  commitId: string;
  user: string;
}

export interface MergedPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly mergedAt: string;
  readonly url: string;
}

export interface IssueCloseSkip {
  readonly number: number;
  readonly reason: string;
}

export interface IssueCloseResult {
  readonly closed: readonly number[];
  readonly skipped: readonly IssueCloseSkip[];
  readonly trackerUpdated: boolean;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  createdAt: string | null;
}

export interface WorkflowRun {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
}

export interface PrEntry {
  readonly number: number;
  readonly branch: string;
  readonly sha: string;
  readonly url: string;
}

export type AutopilotRoute = "work" | "factory";

export interface EvaluationResult {
  readonly route: AutopilotRoute;
  readonly sprint: number | null;
  readonly openIssueCount: number;
  readonly openPrCount: number;
  readonly stalePrCount: number;
  readonly tracker: string;
  readonly reason: string;
  readonly activeSprint: string;
}

export interface PrCiResult {
  readonly pending: readonly PrEntry[];
  readonly dispatched: readonly PrEntry[];
  readonly active: readonly PrEntry[];
  readonly current: readonly PrEntry[];
  readonly failed: readonly PrEntry[];
}

export interface AutopilotDecision {
  holdTarget: boolean;
  targetDispatched: "executed" | "skipped";
}

export interface AutopilotConfig {
  carettaVersion: string;
  agent: string;
  context: string;
  dryRun: boolean;
  enableDispatch: boolean;
  ciWorkflow: string;
  agentBranchPattern: RegExp;
  testCheckName: string;
  /** Resolved `github-token` input; propagated to `gh` / caretta subprocess env. */
  githubToken?: string;
  /** Git author/committer name used when caretta creates commits. */
  gitUserName: string;
  /** Git author/committer email used when caretta creates commits. */
  gitUserEmail: string;
}

export const DEFAULT_AGENT_BRANCH = /^agent\/issue-[0-9]+(?:-.*)?$/;
export const DEFAULT_TEST_CHECK_NAME = "Test";
