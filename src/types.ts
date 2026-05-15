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
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  createdAt: string | null;
}

export interface WorkflowRun {
  id: number;
  headSha: string;
  status: string;
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
  /** Repo owner, used for GitHub App installation lookup. */
  owner: string;
  /** Repo name, used for GitHub App installation lookup. */
  repo: string;
  /** Resolved `github-token` input; used by the action for its own API calls. */
  githubToken?: string;
  /**
   * Token forwarded to the caretta subprocess as GH_TOKEN/GITHUB_TOKEN.
   * Should be a GitHub App installation token when caretta needs to create PRs
   * (the default GITHUB_TOKEN cannot). Falls back to `githubToken` when empty.
   */
  botToken?: string;
  /** Git author/committer name used when caretta creates commits. */
  gitUserName: string;
  /** Git author/committer email used when caretta creates commits. */
  gitUserEmail: string;
}

export const DEFAULT_AGENT_BRANCH = /^agent\/issue-[0-9]+$/;
export const DEFAULT_TEST_CHECK_NAME = "Test";
