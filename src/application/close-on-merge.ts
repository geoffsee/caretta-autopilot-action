import * as core from "@actions/core";
import type { GitHubClient } from "../../packages/action-common/src/github-client.js";
import type {
  IssueCloseResult,
  IssueCloseSkip,
  MergedPullRequest,
} from "../../packages/action-common/src/types.js";

const CLOSING_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*#(\d+)/gi;

/**
 * Parse GitHub closing keywords ("Closes #40", "fixed #41", "Resolves: #42")
 * from a PR body. Returns unique issue numbers in first-seen order.
 *
 * Why: GitHub only auto-closes referenced issues when the merging PR targets
 * the repo's default branch. The autopilot opens PRs against other agent
 * branches (so they can stack), so we must replay the closing-keyword
 * resolution ourselves — otherwise issues stay open and get re-implemented.
 */
export function parseClosingIssueNumbers(body: string): number[] {
  if (!body) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  CLOSING_KEYWORD_RE.lastIndex = 0;
  for (const match of body.matchAll(CLOSING_KEYWORD_RE)) {
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Decide which (pr, issueNumber) pairs need explicit closing.
 *
 * - Skip PRs already targeting `defaultBranch` — GitHub closed those for us.
 * - Skip issue numbers not currently in the `openIssueNumbers` set —
 *   already closed or never existed.
 * - De-duplicate so the same issue is closed at most once per pass.
 */
export interface CloseCandidate {
  readonly pr: MergedPullRequest;
  readonly issueNumber: number;
}

export function selectCloseCandidates(
  mergedPrs: readonly MergedPullRequest[],
  openIssueNumbers: ReadonlySet<number>,
  defaultBranch: string,
): {
  readonly candidates: readonly CloseCandidate[];
  readonly skipped: readonly IssueCloseSkip[];
} {
  const candidates: CloseCandidate[] = [];
  const skipped: IssueCloseSkip[] = [];
  const seen = new Set<number>();
  for (const pr of mergedPrs) {
    const refs = parseClosingIssueNumbers(pr.body);
    if (refs.length === 0) continue;
    const targetsDefault = pr.baseRefName === defaultBranch;
    for (const num of refs) {
      if (seen.has(num)) continue;
      seen.add(num);
      if (targetsDefault) {
        skipped.push({
          number: num,
          reason: `PR #${pr.number} targets default branch ${defaultBranch}; GitHub will close`,
        });
        continue;
      }
      if (!openIssueNumbers.has(num)) {
        skipped.push({
          number: num,
          reason: `issue #${num} is not open`,
        });
        continue;
      }
      candidates.push({ pr, issueNumber: num });
    }
  }
  return { candidates, skipped };
}

/**
 * Replace `- [ ] #N` checklist entries with `- [x] #N` for each closed issue
 * number. Tolerates extra whitespace and surrounding text on the line.
 * Idempotent: already-checked entries are left alone.
 */
export function updateTrackerChecklist(
  body: string,
  closedIssueNumbers: readonly number[],
): string {
  if (!body || closedIssueNumbers.length === 0) return body;
  let updated = body;
  for (const n of closedIssueNumbers) {
    const re = new RegExp(
      String.raw`^(\s*[-*]\s+\[)\s(\]\s+.*#${n}\b.*)$`,
      "gm",
    );
    updated = updated.replace(re, "$1x$2");
  }
  return updated;
}

export interface CloseOnMergeDeps {
  readonly logInfo?: (msg: string) => void;
  readonly logWarning?: (msg: string) => void;
}

/**
 * Side-effecting orchestrator: list recently-merged PRs, replay closing
 * keywords against open issues, close referenced issues with a back-link
 * comment, and tick the matching boxes on the active tracker issue.
 */
export async function closeIssuesForMergedPrs(
  gh: GitHubClient,
  openIssueNumbers: ReadonlySet<number>,
  trackerNumber: number | null,
  deps: CloseOnMergeDeps = {},
): Promise<IssueCloseResult> {
  const info = deps.logInfo ?? ((m: string) => core.info(m));
  const warn = deps.logWarning ?? ((m: string) => core.warning(m));

  const [mergedPrs, defaultBranch] = await Promise.all([
    gh.listRecentlyMergedPullRequests(),
    gh.getDefaultBranch(),
  ]);

  const { candidates, skipped } = selectCloseCandidates(
    mergedPrs,
    openIssueNumbers,
    defaultBranch,
  );

  const closed: number[] = [];
  for (const { pr, issueNumber } of candidates) {
    const comment =
      `Closed by merged PR ${pr.url} (#${pr.number}).\n\n` +
      `Auto-closed by autopilot because the PR targeted \`${pr.baseRefName}\` ` +
      `rather than \`${defaultBranch}\`, so GitHub's closing-keyword automation did not fire.`;
    try {
      await gh.closeIssueWithComment(issueNumber, comment);
      closed.push(issueNumber);
      info(`closed issue #${issueNumber} (merged via PR #${pr.number})`);
    } catch (err) {
      warn(
        `failed to close issue #${issueNumber} for PR #${pr.number}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  let trackerUpdated = false;
  if (trackerNumber !== null && closed.length > 0) {
    try {
      const body = await gh.getIssueBody(trackerNumber);
      const next = updateTrackerChecklist(body, closed);
      if (next !== body) {
        await gh.updateIssueBody(trackerNumber, next);
        trackerUpdated = true;
        info(
          `updated tracker #${trackerNumber} checklist for ${closed.length} closed issue(s)`,
        );
      }
    } catch (err) {
      warn(
        `failed to update tracker #${trackerNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { closed, skipped, trackerUpdated };
}
