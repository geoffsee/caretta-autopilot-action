import { describe, expect, test } from "bun:test";
import { countStalePRs, evaluate, findActiveSprint } from "../src/evaluate.js";
import { makeIssue, makePR } from "./fakes.js";

describe("findActiveSprint", () => {
  test("returns null when no sprint label exists", () => {
    const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2 })];
    expect(findActiveSprint(issues)).toBeNull();
  });

  test("returns the most-recently-updated sprint", () => {
    const issues = [
      makeIssue({
        number: 10,
        labels: [{ name: "sprint" }],
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      makeIssue({
        number: 11,
        labels: [{ name: "sprint" }],
        updatedAt: "2026-02-01T00:00:00Z",
      }),
      makeIssue({
        number: 12,
        labels: [{ name: "sprint" }],
        updatedAt: "2026-01-15T00:00:00Z",
      }),
    ];
    expect(findActiveSprint(issues)).toBe(11);
  });
});

describe("countStalePRs", () => {
  test.each([
    {
      name: "counts only non-draft PRs needing review action",
      prs: [
        makePR({ number: 1, reviewDecision: "CHANGES_REQUESTED" }),
        makePR({ number: 2, reviewDecision: "REVIEW_REQUIRED" }),
        makePR({ number: 3, reviewDecision: "APPROVED" }),
        makePR({
          number: 4,
          isDraft: true,
          reviewDecision: "CHANGES_REQUESTED",
        }),
      ],
      expected: 2,
    },
    { name: "returns 0 for empty PR list", prs: [], expected: 0 },
    {
      name: "returns 0 if no PRs need action",
      prs: [
        makePR({ number: 3, reviewDecision: "APPROVED" }),
        makePR({ number: 5, isDraft: true }),
      ],
      expected: 0,
    },
  ])("$name", ({ prs, expected }) => {
    expect(countStalePRs(prs)).toBe(expected);
  });
});

describe("evaluate", () => {
  test("chooses work route when sprint exists", () => {
    const result = evaluate(
      [makeIssue({ number: 42, labels: [{ name: "sprint" }] })],
      [],
    );
    expect(result.route).toBe("work");
    expect(result.tracker).toBe("42");
    expect(result.sprint).toBe(42);
    expect(result.reason).toContain("#42");
    expect(result.activeSprint).toBe("#42");
  });

  test("chooses factory route when no sprint exists", () => {
    const result = evaluate([], []);
    expect(result.route).toBe("factory");
    expect(result.tracker).toBe("");
    expect(result.sprint).toBeNull();
    expect(result.activeSprint).toBe("none");
  });

  test("reports counts on the result", () => {
    const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2 })];
    const prs = [
      makePR({ number: 10 }),
      makePR({ number: 11, reviewDecision: "CHANGES_REQUESTED" }),
    ];
    const result = evaluate(issues, prs);
    expect(result.openIssueCount).toBe(2);
    expect(result.openPrCount).toBe(2);
    expect(result.stalePrCount).toBe(1);
  });
});
