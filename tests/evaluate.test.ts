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
  test("counts only non-draft PRs needing review action", () => {
    const prs = [
      makePR({ number: 1, reviewDecision: "CHANGES_REQUESTED" }),
      makePR({ number: 2, reviewDecision: "REVIEW_REQUIRED" }),
      makePR({ number: 3, reviewDecision: "APPROVED" }),
      makePR({ number: 4, isDraft: true, reviewDecision: "CHANGES_REQUESTED" }),
    ];
    expect(countStalePRs(prs)).toBe(2);
  });
});

describe("evaluate", () => {
  test("chooses tracker workflow when sprint exists", () => {
    const issues = [makeIssue({ number: 42, labels: [{ name: "sprint" }] })];
    const result = evaluate(issues, [], "tracker.yml", "factory.yml");
    expect(result.workflow).toBe("tracker.yml");
    expect(result.tracker).toBe("42");
    expect(result.sprint).toBe(42);
    expect(result.reason).toContain("#42");
    expect(result.activeSprint).toBe("#42");
  });

  test("chooses factory workflow when no sprint exists", () => {
    const result = evaluate([], [], "tracker.yml", "factory.yml");
    expect(result.workflow).toBe("factory.yml");
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
    const result = evaluate(issues, prs, "tracker.yml", "factory.yml");
    expect(result.openIssueCount).toBe(2);
    expect(result.openPrCount).toBe(2);
    expect(result.stalePrCount).toBe(1);
  });
});
