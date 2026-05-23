import * as core from "@actions/core";
import type { GitHubClient } from "@caretta/action-common/github-client";
import type {
  IssueCloseResult,
  IssueCloseSkip,
  MergedPullRequest,
} from "@caretta/action-common/types";

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
 * `openIssueNumbers` is the sole authority: if the linked issue is still in
 * the open-issue set after a merge, we close it ourselves, regardless of
 * whether the PR targeted the default branch. GitHub does not auto-close
 * PRs authored and merged by GitHub App identities (which is the autopilot's
 * actor) even when they target the default branch, so a default-branch skip
 * is not safe. If GitHub *did* close the issue, it falls out of
 * `openIssueNumbers` and the "not open" skip catches it.
 *
 * - Skip issue numbers not currently in `openIssueNumbers` — already closed
 *   (by GitHub or by hand) or never existed.
 * - De-duplicate so the same issue is closed at most once per pass.
 *
 * The `defaultBranch` parameter is retained for the back-link comment.
 */
export interface CloseCandidate {
  readonly pr: MergedPullRequest;
  readonly issueNumber: number;
}

export function selectCloseCandidates(
  mergedPrs: readonly MergedPullRequest[],
  openIssueNumbers: ReadonlySet<number>,
  _defaultBranch: string,
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
    for (const num of refs) {
      if (seen.has(num)) continue;
      seen.add(num);
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

const CHECKBOX_TICKED_RE = /^\s*[-*]\s+\[[xX]\]/m;
const CHECKBOX_UNTICKED_RE = /^\s*[-*]\s+\[\s\]/m;
const CHECKLIST_ROW_ISSUE_RE = /^\s*[-*]\s+\[[ xX]\]\s+[^\n#]*?#(\d+)\b/gm;

/**
 * True when `body` contains at least one ticked checkbox row and zero
 * unticked rows. Used by `closeIssuesForMergedPrs` to decide whether the
 * tracker has nothing left to deliver and should be closed.
 *
 * Requires at least one tick so a tracker body without any checklist (or
 * with only unrelated `[ ]` text in prose) is never mistakenly treated
 * as complete.
 */
export function isChecklistComplete(body: string): boolean {
  if (!body) return false;
  if (!CHECKBOX_TICKED_RE.test(body)) return false;
  return !CHECKBOX_UNTICKED_RE.test(body);
}

/**
 * Return the leading `#N` issue reference from each checklist row in
 * `body`, in document order. Annotations like "(blocked by #180)" further
 * along the same row are ignored — only the first `#N` is the primary
 * referent.
 *
 * Why: a ticked checkbox is a claim that the linked issue is done, but
 * any prior pass (a draft, a retro, a stale `updateTrackerChecklist`
 * call) can set that claim prematurely. Cross-referencing the actual
 * open-issue set against these refs is what keeps `closeIssuesForMergedPrs`
 * from closing a tracker on a lie.
 */
export function extractChecklistIssueRefs(body: string): number[] {
  if (!body) return [];
  const out: number[] = [];
  CHECKLIST_ROW_ISSUE_RE.lastIndex = 0;
  for (const match of body.matchAll(CHECKLIST_ROW_ISSUE_RE)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
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
    const baseNote =
      pr.baseRefName === defaultBranch
        ? "GitHub's closing-keyword automation did not fire (the PR was authored or merged by a GitHub App identity)"
        : `the PR targeted \`${pr.baseRefName}\` rather than \`${defaultBranch}\`, so GitHub's closing-keyword automation did not fire`;
    const comment =
      `Closed by merged PR ${pr.url} (#${pr.number}).\n\n` +
      `Auto-closed by autopilot because ${baseNote}.`;
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
  let trackerCompleted = false;
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
      if (isChecklistComplete(next)) {
        const closedInPass = new Set(closed);
        const stillOpenRefs = extractChecklistIssueRefs(next).filter(
          (n) => openIssueNumbers.has(n) && !closedInPass.has(n),
        );
        if (stillOpenRefs.length > 0) {
          warn(
            `tracker #${trackerNumber} checklist appears complete but still references open issue(s): ${stillOpenRefs
              .map((n) => `#${n}`)
              .join(", ")}; leaving tracker open`,
          );
        } else {
          try {
            await gh.closeIssueWithComment(
              trackerNumber,
              "All sprint items shipped. Closing tracker as completed so the next autopilot tick routes to the factory cycle and plans the next sprint.",
            );
            trackerCompleted = true;
            info(`closed completed tracker #${trackerNumber}`);
          } catch (err) {
            warn(
              `failed to close completed tracker #${trackerNumber}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    } catch (err) {
      warn(
        `failed to update tracker #${trackerNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { closed, skipped, trackerUpdated, trackerCompleted };
}
