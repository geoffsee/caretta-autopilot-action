import { describe, expect, test } from "bun:test";
import {
  closeIssuesForMergedPrs,
  parseClosingIssueNumbers,
  selectCloseCandidates,
  updateTrackerChecklist,
} from "../src/application/close-on-merge.js";
import { FakeGitHub, makeMergedPR } from "./fakes.js";

describe("parseClosingIssueNumbers", () => {
  test.each([
    { name: "single Closes", body: "Closes #40", expected: [40] },
    {
      name: "lowercase closes",
      body: "closes #41 in this PR",
      expected: [41],
    },
    { name: "Fixes keyword", body: "Fixes #42", expected: [42] },
    { name: "Resolves keyword", body: "Resolves #43", expected: [43] },
    { name: "past tense fixed", body: "fixed #44", expected: [44] },
    { name: "past tense resolved", body: "resolved #45", expected: [45] },
    { name: "past tense closed", body: "closed #46", expected: [46] },
    {
      name: "colon separator (Resolves: #N)",
      body: "Resolves: #47",
      expected: [47],
    },
    {
      name: "multiple keywords across lines",
      body: "Closes #40\nFixes #41\nResolves #42",
      expected: [40, 41, 42],
    },
    {
      name: "deduplicates same issue mentioned twice",
      body: "Closes #40 and also fixes #40",
      expected: [40],
    },
    {
      name: "ignores bare issue references (#42 mentioned for context)",
      body: "See #42 for background; closes #43",
      expected: [43],
    },
    {
      name: "ignores keyword without # prefix",
      body: "Closes 42 (no hash)",
      expected: [],
    },
    { name: "empty body", body: "", expected: [] },
    {
      name: "ignores zero issue number",
      body: "Closes #0",
      expected: [],
    },
  ])("$name", ({ body, expected }) => {
    expect(parseClosingIssueNumbers(body)).toEqual([...expected]);
  });
});

describe("selectCloseCandidates", () => {
  test("includes PRs targeting non-default base ref (regression: GitHub does NOT auto-close these)", () => {
    const mergedPrs = [
      makeMergedPR({
        number: 54,
        body: "Closes #40",
        headRefName: "agent/issue-40",
        baseRefName: "agent/issue-36",
      }),
    ];
    const { candidates, skipped } = selectCloseCandidates(
      mergedPrs,
      new Set([40]),
      "main",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(40);
    expect(candidates[0].pr.number).toBe(54);
    expect(skipped).toEqual([]);
  });

  test("default-branch merge whose linked issue GitHub already closed is skipped as 'not open' (issue dropped from openIssueNumbers)", () => {
    // The historical assumption was "PR targets default → GitHub closed it →
    // skip." That is correct *when GitHub actually closed it* — in which case
    // the issue is no longer in openIssueNumbers and the "not open" skip
    // catches it. The bug (sprint #140 incident) was the skip firing on the
    // base-branch alone, without consulting openIssueNumbers.
    const mergedPrs = [
      makeMergedPR({
        number: 50,
        body: "Closes #39",
        baseRefName: "main",
      }),
    ];
    const { candidates, skipped } = selectCloseCandidates(
      mergedPrs,
      new Set<number>(),
      "main",
    );
    expect(candidates).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].number).toBe(39);
    expect(skipped[0].reason).toContain("not open");
  });

  test("regression (sprint #140 / PRs #141–#146): produces a candidate when a default-branch merge's linked issue is still in the open-issue set — GitHub does NOT auto-close PRs authored+merged by GitHub Apps, so the autopilot must replay closure", () => {
    // Live shape on geoffsee/autopilot-example-project as of 2026-05-20:
    //   PR #145 merged into main with body "Closes #139", authored and merged
    //   by app/github-actions[bot]. Issue #139's timeline has no `closed`
    //   event and `gh issue list` still reports it OPEN. The next autopilot
    //   tick called `runAutopilot`, which passed `#139` in openIssueNumbers
    //   to `selectCloseCandidates`. The expected behavior is to produce a
    //   candidate (close the issue ourselves); the current implementation
    //   takes the `targetsDefault` skip branch before consulting
    //   openIssueNumbers and the issue stays open, which lets the work-loop
    //   re-dispatch on the next tick and open duplicate PRs (#146, #147,
    //   #148 in the live incident).
    const mergedPrs = [
      makeMergedPR({
        number: 145,
        body: "Closes #139\n\nAutomated PR opened by caretta issue runner.",
        headRefName: "agent/issue-139",
        baseRefName: "main",
      }),
    ];
    const { candidates, skipped } = selectCloseCandidates(
      mergedPrs,
      new Set([139]),
      "main",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].issueNumber).toBe(139);
    expect(candidates[0].pr.number).toBe(145);
    expect(skipped).toEqual([]);
  });

  test("skips issues that are not currently open", () => {
    const mergedPrs = [
      makeMergedPR({
        number: 60,
        body: "Closes #99",
        baseRefName: "agent/issue-1",
      }),
    ];
    const { candidates, skipped } = selectCloseCandidates(
      mergedPrs,
      new Set([1, 2, 3]),
      "main",
    );
    expect(candidates).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].number).toBe(99);
    expect(skipped[0].reason).toContain("not open");
  });

  test("de-duplicates when several merged PRs reference the same issue (re-implementation scenario)", () => {
    const mergedPrs = [
      makeMergedPR({
        number: 51,
        body: "Closes #40",
        baseRefName: "agent/issue-36",
      }),
      makeMergedPR({
        number: 53,
        body: "Closes #40",
        baseRefName: "agent/issue-36",
      }),
      makeMergedPR({
        number: 54,
        body: "Closes #40",
        baseRefName: "agent/issue-36",
      }),
    ];
    const { candidates } = selectCloseCandidates(
      mergedPrs,
      new Set([40]),
      "main",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].pr.number).toBe(51);
  });

  test("handles PR body with no closing keyword gracefully", () => {
    const mergedPrs = [
      makeMergedPR({
        number: 70,
        body: "See #40 (no keyword)",
        baseRefName: "agent/issue-36",
      }),
    ];
    const { candidates, skipped } = selectCloseCandidates(
      mergedPrs,
      new Set([40]),
      "main",
    );
    expect(candidates).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});

describe("updateTrackerChecklist", () => {
  test("ticks `- [ ] #N` for each closed issue", () => {
    const body =
      "## Sprint backlog\n" +
      "- [ ] #40 OpenTelemetry tracing\n" +
      "- [ ] #41 React counter UI\n" +
      "- [ ] #42 Plugin manifest\n";
    const next = updateTrackerChecklist(body, [40, 42]);
    expect(next).toContain("- [x] #40 OpenTelemetry tracing");
    expect(next).toContain("- [ ] #41 React counter UI");
    expect(next).toContain("- [x] #42 Plugin manifest");
  });

  test("idempotent on already-checked entries", () => {
    const body = "- [x] #40 already done\n- [ ] #41 to do\n";
    const next = updateTrackerChecklist(body, [40, 41]);
    expect(next).toBe("- [x] #40 already done\n- [x] #41 to do\n");
  });

  test("supports `*`-style bullets and extra leading whitespace", () => {
    const body = "  * [ ] #40 indented\n";
    expect(updateTrackerChecklist(body, [40])).toBe("  * [x] #40 indented\n");
  });

  test("does not change unrelated lines", () => {
    const body = "Body text mentioning #40 inline.\nOther content.";
    expect(updateTrackerChecklist(body, [40])).toBe(body);
  });

  test("empty body or empty closed list is a no-op", () => {
    expect(updateTrackerChecklist("", [40])).toBe("");
    expect(updateTrackerChecklist("- [ ] #40", [])).toBe("- [ ] #40");
  });

  test("only ticks the exact issue number (not a longer number containing it)", () => {
    const body = "- [ ] #4 short\n- [ ] #40 long\n- [ ] #400 longer\n";
    const next = updateTrackerChecklist(body, [4]);
    expect(next).toBe("- [x] #4 short\n- [ ] #40 long\n- [ ] #400 longer\n");
  });
});

describe("closeIssuesForMergedPrs", () => {
  test("closes issue referenced by a merged PR targeting a non-default base, and comments the back-link", async () => {
    const gh = new FakeGitHub({
      mergedPrs: [
        makeMergedPR({
          number: 54,
          body: "Closes #40",
          baseRefName: "agent/issue-36",
          url: "https://example/pull/54",
        }),
      ],
      defaultBranch: "main",
    });
    const result = await closeIssuesForMergedPrs(gh, new Set([40]), null);
    expect(result.closed).toEqual([40]);
    expect(gh.closedIssues).toHaveLength(1);
    expect(gh.closedIssues[0].issueNumber).toBe(40);
    expect(gh.closedIssues[0].comment).toContain("https://example/pull/54");
    expect(gh.closedIssues[0].comment).toContain("agent/issue-36");
  });

  test("regression (sprint #140): closes issue referenced by default-branch merge when the issue is still open — GitHub's auto-close did not fire (bot author/merger)", async () => {
    const gh = new FakeGitHub({
      mergedPrs: [
        makeMergedPR({
          number: 145,
          body: "Closes #139\n\nAutomated PR opened by caretta issue runner.",
          headRefName: "agent/issue-139",
          baseRefName: "main",
          url: "https://example/pull/145",
        }),
      ],
      defaultBranch: "main",
    });
    const result = await closeIssuesForMergedPrs(gh, new Set([139]), null);
    expect(result.closed).toEqual([139]);
    expect(gh.closedIssues).toHaveLength(1);
    expect(gh.closedIssues[0].issueNumber).toBe(139);
    expect(gh.closedIssues[0].comment).toContain("https://example/pull/145");
    expect(gh.closedIssues[0].comment).toContain("GitHub App identity");
  });

  test("default-branch merge whose linked issue is no longer open is a no-op (GitHub already closed it)", async () => {
    const gh = new FakeGitHub({
      mergedPrs: [
        makeMergedPR({
          number: 50,
          body: "Closes #39",
          baseRefName: "main",
        }),
      ],
      defaultBranch: "main",
    });
    const result = await closeIssuesForMergedPrs(gh, new Set<number>(), null);
    expect(result.closed).toEqual([]);
    expect(gh.closedIssues).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("not open");
  });

  test("ticks the tracker's checklist for each closed issue", async () => {
    const gh = new FakeGitHub({
      mergedPrs: [
        makeMergedPR({
          number: 54,
          body: "Closes #40",
          baseRefName: "agent/issue-36",
        }),
      ],
      defaultBranch: "main",
      issueBodies: {
        43: "## Sprint backlog\n- [ ] #40 tracing\n- [ ] #41 ui\n",
      },
    });
    const result = await closeIssuesForMergedPrs(gh, new Set([40]), 43);
    expect(result.closed).toEqual([40]);
    expect(result.trackerUpdated).toBe(true);
    expect(gh.updatedIssueBodies).toHaveLength(1);
    expect(gh.updatedIssueBodies[0].issueNumber).toBe(43);
    expect(gh.updatedIssueBodies[0].body).toContain("- [x] #40 tracing");
    expect(gh.updatedIssueBodies[0].body).toContain("- [ ] #41 ui");
  });

  test("skips tracker update when no issues were closed (linked issue already gone from openIssueNumbers)", async () => {
    const gh = new FakeGitHub({
      mergedPrs: [
        makeMergedPR({
          number: 50,
          body: "Closes #39",
          baseRefName: "main",
        }),
      ],
      defaultBranch: "main",
      issueBodies: { 43: "- [ ] #39\n" },
    });
    const result = await closeIssuesForMergedPrs(gh, new Set<number>(), 43);
    expect(result.closed).toEqual([]);
    expect(result.trackerUpdated).toBe(false);
    expect(gh.updatedIssueBodies).toHaveLength(0);
  });

  test("warns when tracker checklist update fails", async () => {
    const warnings: string[] = [];
    const gh = new FakeGitHub({
      mergedPrs: [
        makeMergedPR({
          number: 54,
          body: "Closes #40",
          baseRefName: "agent/issue-36",
        }),
      ],
      defaultBranch: "main",
      issueBodies: {
        43: "## Sprint backlog\n- [ ] #40 tracing\n- [ ] #41 ui\n",
      },
      updateIssueBodyShouldFail: (n) => n === 43,
    });
    const result = await closeIssuesForMergedPrs(gh, new Set([40]), 43, {
      logInfo: () => {},
      logWarning: (m) => warnings.push(m),
    });
    expect(result.closed).toEqual([40]);
    expect(result.trackerUpdated).toBe(false);
    expect(
      warnings.some((w) => w.includes("failed to update tracker #43")),
    ).toBe(true);
  });

  test("warns and continues when closeIssueWithComment fails for one issue", async () => {
    const warnings: string[] = [];
    const gh = new FakeGitHub({
      mergedPrs: [
        makeMergedPR({
          number: 54,
          body: "Closes #40",
          baseRefName: "agent/issue-36",
        }),
        makeMergedPR({
          number: 55,
          body: "Closes #41",
          baseRefName: "agent/issue-36",
        }),
      ],
      defaultBranch: "main",
      closeIssueShouldFail: (n) => n === 40,
    });
    const result = await closeIssuesForMergedPrs(gh, new Set([40, 41]), null, {
      logInfo: () => {},
      logWarning: (m) => warnings.push(m),
    });
    expect(result.closed).toEqual([41]);
    expect(warnings.some((w) => w.includes("#40"))).toBe(true);
  });

  test("regression: re-running close-on-merge after a successful pass does not re-close the same issue", async () => {
    const merged = makeMergedPR({
      number: 54,
      body: "Closes #40",
      baseRefName: "agent/issue-36",
    });

    // First pass: issue #40 is open
    const gh1 = new FakeGitHub({
      mergedPrs: [merged],
      defaultBranch: "main",
    });
    const r1 = await closeIssuesForMergedPrs(gh1, new Set([40]), null);
    expect(r1.closed).toEqual([40]);

    // Second pass models the next cron tick: #40 is now closed, so it is
    // no longer in the open-issue set. The same merged PR must not be
    // re-processed against it.
    const gh2 = new FakeGitHub({
      mergedPrs: [merged],
      defaultBranch: "main",
    });
    const r2 = await closeIssuesForMergedPrs(gh2, new Set<number>(), null);
    expect(r2.closed).toEqual([]);
    expect(gh2.closedIssues).toHaveLength(0);
  });

  test("regression: same issue referenced by N stacked merged PRs is closed exactly once", async () => {
    // Mirrors the live state we hit on issue #40 (PRs #51, #53, #54).
    const gh = new FakeGitHub({
      mergedPrs: [
        makeMergedPR({
          number: 51,
          body: "Closes #40",
          baseRefName: "agent/issue-36",
        }),
        makeMergedPR({
          number: 53,
          body: "Closes #40",
          baseRefName: "agent/issue-36",
        }),
        makeMergedPR({
          number: 54,
          body: "Closes #40",
          baseRefName: "agent/issue-36",
        }),
      ],
      defaultBranch: "main",
    });
    const result = await closeIssuesForMergedPrs(gh, new Set([40]), null);
    expect(result.closed).toEqual([40]);
    expect(gh.closedIssues).toHaveLength(1);
  });
});
