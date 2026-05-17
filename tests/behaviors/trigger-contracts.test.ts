/**
 * Behavior contract suite: GitHub event gate (`decideTrigger`).
 * Contract IDs are defined in `contract-registry.ts`.
 */
import { describe, expect, test } from "bun:test";
import { decideTrigger } from "../../src/trigger.js";

describe("trigger behavior contracts", () => {
  test("AP-TR-001: schedule always runs", () => {
    expect(decideTrigger({ eventName: "schedule", payload: {} })).toEqual({
      run: true,
      reason: "scheduled heartbeat",
    });
  });

  test("AP-TR-002: workflow_dispatch always runs", () => {
    expect(
      decideTrigger({ eventName: "workflow_dispatch", payload: {} }),
    ).toEqual({ run: true, reason: "manual dispatch" });
  });

  test("AP-TR-003: issues with sprint label run", () => {
    const d = decideTrigger({
      eventName: "issues",
      payload: {
        action: "opened",
        issue: { labels: [{ name: "sprint" }] },
      },
    });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("sprint");
  });

  test("AP-TR-004: issues closed run without sprint label", () => {
    expect(
      decideTrigger({
        eventName: "issues",
        payload: { action: "closed", issue: { labels: [] } },
      }),
    ).toEqual({ run: true, reason: "issue closed" });
  });

  test("AP-TR-005: issues without sprint (non-closed) skip", () => {
    const d = decideTrigger({
      eventName: "issues",
      payload: { action: "opened", issue: { labels: [{ name: "bug" }] } },
    });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("without sprint label");
  });

  test("AP-TR-006: agent pull_request runs", () => {
    const d = decideTrigger({
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        pull_request: { head: { ref: "agent/issue-12" } },
      },
    });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("agent PR");
  });

  test("AP-TR-007: non-agent pull_request skips", () => {
    const d = decideTrigger({
      eventName: "pull_request",
      payload: {
        action: "opened",
        pull_request: { head: { ref: "feature/foo" } },
      },
    });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("non-agent");
  });

  test("AP-TR-008: workflow_run on agent branch runs", () => {
    const d = decideTrigger({
      eventName: "workflow_run",
      payload: {
        workflow_run: { head_branch: "agent/issue-9", conclusion: "success" },
      },
    });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("agent CI");
  });

  test("AP-TR-009: workflow_run on main skips", () => {
    const d = decideTrigger({
      eventName: "workflow_run",
      payload: {
        workflow_run: { head_branch: "main", conclusion: "success" },
      },
    });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("non-agent");
  });

  test("AP-TR-010: unknown events skip", () => {
    const d = decideTrigger({
      eventName: "status",
      payload: {},
    });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("unhandled");
  });
});
