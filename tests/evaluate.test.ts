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
        makePR({ number: 4, isDraft: true, reviewDecision: "CHANGES_REQUESTED" }),
      ],
      expected: 2,
    },
    {
      name: "returns 0 for empty PR list",
      prs: [],
      expected: 0,
    },
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
  test.each([
    {
      name: "chooses tracker workflow when sprint exists",
      issues: [makeIssue({ number: 42, labels: [{ name: "sprint" }] })],
      prs: [],
      expectedWorkflow: "tracker.yml",
      expectedTracker: "42",
      expectedSprint: 42,
    },
    {
      name: "chooses factory workflow when no sprint exists",
      issues: [],
      prs: [],
      expectedWorkflow: "factory.yml",
      expectedTracker: "",
      expectedSprint: null,
    },
  ])("$name", ({ issues, prs, expectedWorkflow, expectedTracker, expectedSprint }) => {
    const result = evaluate(issues, prs, "tracker.yml", "factory.yml");
    expect(result.workflow).toBe(expectedWorkflow);
    expect(result.tracker).toBe(expectedTracker);
    expect(result.sprint).toBe(expectedSprint);
    if (expectedSprint) {
      expect(result.reason).toContain(`#${expectedSprint}`);
      expect(result.activeSprint).toBe(`#${expectedSprint}`);
    } else {
      expect(result.activeSprint).toBe("none");
    }
  });

  test("reports counts on the result", () => {
    const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2 })];
    const prs = [
      makePR({ number: 10 }),
      makePR({ number: 11, reviewDecision: "CHANGES_REQUESTED" }),
    ];
    const result = evaluate(issues, prs, "tracker.yml", "factory.yml");
    expect(result.openIssueCount).toBe(2);
    expect(result.openPrCount).toBe(2);
    expect(result.stalePrCount).toBe(1);
  });
});
