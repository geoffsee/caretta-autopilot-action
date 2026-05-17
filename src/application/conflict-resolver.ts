import * as core from "@actions/core";
import type { ExecClient } from "../../packages/action-common/src/exec-client.js";
import type { GitHubClient } from "../../packages/action-common/src/github-client.js";
import type {
  AutopilotConfig,
  PullRequest,
} from "../../packages/action-common/src/types.js";

export interface ConflictResolverOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly prNumbers?: readonly number[];
  readonly maxAttemptsPerPr?: number;
}

export interface ConflictResolverDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fixConflicts: (prNumber: number) => Promise<void>;
}

export interface ConflictResolverResult {
  readonly fixed: readonly number[];
  readonly unresolved: readonly number[];
  readonly timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * GitHub computes mergeStateStatus asynchronously, so conflicts surface after
 * the initial PR scan; without polling, a DIRTY PR blocks downstream CI until
 * the next autopilot tick.
 */
export class ConflictResolver {
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly maxAttemptsPerPr: number;
  private readonly scope?: ReadonlySet<number>;
  private readonly deps: ConflictResolverDeps;
  private readonly attempts = new Map<number, number>();

  constructor(
    private readonly gh: GitHubClient,
    private readonly config: AutopilotConfig,
    options: ConflictResolverOptions = {},
    deps?: Partial<ConflictResolverDeps>,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxAttemptsPerPr = options.maxAttemptsPerPr ?? DEFAULT_MAX_ATTEMPTS;
    this.scope = options.prNumbers ? new Set(options.prNumbers) : undefined;
    this.deps = {
      now: deps?.now ?? Date.now,
      sleep: deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      fixConflicts:
        deps?.fixConflicts ??
        ((n) => {
          throw new Error(
            `ConflictResolver: no fixConflicts dependency configured (pr #${n})`,
          );
        }),
    };
  }

  static withCaretta(
    gh: GitHubClient,
    config: AutopilotConfig,
    binaryPath: string,
    env: Record<string, string>,
    exec: ExecClient,
    options: ConflictResolverOptions = {},
  ): ConflictResolver {
    return new ConflictResolver(gh, config, options, {
      fixConflicts: async (prNumber) => {
        await exec.exec(
          binaryPath,
          [
            "--auto",
            "--agent",
            config.agent,
            "fix-conflicts",
            String(prNumber),
          ],
          { env },
        );
      },
    });
  }

  async resolveAll(): Promise<ConflictResolverResult> {
    const fixed = new Set<number>();
    const start = this.deps.now();
    let timedOut = false;

    while (true) {
      const dirty = await this.findDirty();
      const actionable = dirty.filter(
        (pr) => (this.attempts.get(pr.number) ?? 0) < this.maxAttemptsPerPr,
      );
      if (actionable.length === 0) break;

      for (const pr of actionable) {
        const prior = this.attempts.get(pr.number) ?? 0;
        this.attempts.set(pr.number, prior + 1);
        core.info(
          `ConflictResolver: fix-conflicts on PR #${pr.number} (attempt ${prior + 1})`,
        );
        try {
          await this.deps.fixConflicts(pr.number);
          fixed.add(pr.number);
        } catch (err) {
          core.warning(
            `ConflictResolver: fix-conflicts failed for PR #${pr.number}: ${
              (err as Error).message
            }`,
          );
        }
      }

      if (this.deps.now() - start >= this.timeoutMs) {
        timedOut = true;
        break;
      }
      await this.deps.sleep(this.intervalMs);
    }

    const remaining = await this.findDirty();
    return {
      fixed: [...fixed],
      unresolved: remaining.map((p) => p.number),
      timedOut,
    };
  }

  private async findDirty(): Promise<PullRequest[]> {
    const prs = await this.gh.listOpenPullRequests();
    return prs.filter((pr) => {
      if (pr.isDraft) return false;
      if (!this.config.agentBranchPattern.test(pr.headRefName)) return false;
      if (pr.mergeStateStatus !== "DIRTY") return false;
      if (this.scope && !this.scope.has(pr.number)) return false;
      return true;
    });
  }
}
