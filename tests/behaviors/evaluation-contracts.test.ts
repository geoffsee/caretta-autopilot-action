/**
 * Behavior contract suite: evaluation routing and sprint selection.
 */
import { describe, expect, test } from "bun:test";
import type { Issue } from "@caretta/action-common/types";
import { DEFAULT_AGENT_BRANCH } from "@caretta/action-common/types";
import { evaluate, findActiveSprint } from "../../src/domain/evaluate.js";

function issue(n: number, labels: string[], updatedAt: string): Issue {
  return {
    number: n,
    title: `Issue ${n}`,
    labels: labels.map((name) => ({ name })),
    updatedAt,
    url: `https://example.com/issues/${n}`,
  };
}

describe("evaluation behavior contracts", () => {
  test("AP-EV-001: sprint present → work route and tracker id", () => {
    const issues = [issue(42, ["sprint"], "2026-01-02T00:00:00Z")];
    const out = evaluate(issues, []);
    expect(out.route).toBe("work");
    expect(out.tracker).toBe("42");
    expect(out.sprint).toBe(42);
    expect(out.reason.toLowerCase()).toContain("work");
  });

  test("AP-EV-002: no sprint → factory route and empty tracker", () => {
    const out = evaluate([], []);
    expect(out.route).toBe("factory");
    expect(out.sprint).toBeNull();
    expect(out.tracker).toBe("");
    expect(out.reason.toLowerCase()).toContain("factory");
  });

  test("AP-EV-003: sprint tracker selection — trackers beat sprint-only; else newest sprint", () => {
    const withTrackers = findActiveSprint([
      issue(1, ["sprint"], "2026-01-10T00:00:00Z"),
      issue(2, ["sprint", "tracker"], "2026-01-05T00:00:00Z"),
      issue(3, ["sprint", "tracker"], "2026-01-08T00:00:00Z"),
    ]);
    expect(withTrackers).toBe(3);

    const sprintOnly = findActiveSprint([
      issue(10, ["sprint"], "2026-01-01T00:00:00Z"),
      issue(11, ["sprint"], "2026-01-09T00:00:00Z"),
    ]);
    expect(sprintOnly).toBe(11);
  });
});

describe("DEFAULT_AGENT_BRANCH (shared constant with trigger prefix)", () => {
  test("agent branch pattern matches agent/issue-<n> and suffixes", () => {
    expect(DEFAULT_AGENT_BRANCH.test("agent/issue-1")).toBe(true);
    expect(DEFAULT_AGENT_BRANCH.test("agent/issue-1-fix-bug")).toBe(true);
    expect(DEFAULT_AGENT_BRANCH.test("agent/issue-")).toBe(false);
    expect(DEFAULT_AGENT_BRANCH.test("feature/agent/issue-1")).toBe(false);
  });
});
