import { describe, expect, test } from "bun:test";
import { decideTrigger } from "../src/trigger.js";

describe("decideTrigger", () => {
  test("schedule always runs", () => {
    expect(decideTrigger({ eventName: "schedule", payload: {} })).toEqual({
      run: true,
      reason: "scheduled heartbeat",
    });
  });

  test("workflow_dispatch always runs", () => {
    expect(
      decideTrigger({ eventName: "workflow_dispatch", payload: {} }),
    ).toEqual({ run: true, reason: "manual dispatch" });
  });

  test("issues closed runs even without sprint label", () => {
    const d = decideTrigger({
      eventName: "issues",
      payload: { action: "closed", issue: { labels: [] } },
    });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("issue closed");
  });

  test("issues opened with sprint label runs", () => {
    const d = decideTrigger({
      eventName: "issues",
      payload: {
        action: "opened",
        issue: { labels: [{ name: "sprint" }, { name: "p0" }] },
      },
    });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("sprint");
  });

  test("issues labeled with sprint runs", () => {
    const d = decideTrigger({
      eventName: "issues",
      payload: {
        action: "labeled",
        issue: { labels: [{ name: "sprint" }] },
      },
    });
    expect(d.run).toBe(true);
  });

  test("issues opened without sprint label skips", () => {
    const d = decideTrigger({
      eventName: "issues",
      payload: { action: "opened", issue: { labels: [{ name: "bug" }] } },
    });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("without sprint label");
  });

  test("issues with string-form labels works", () => {
    const d = decideTrigger({
      eventName: "issues",
      payload: { action: "labeled", issue: { labels: ["sprint"] } },
    });
    expect(d.run).toBe(true);
  });

  test("pull_request on agent branch runs", () => {
    const d = decideTrigger({
      eventName: "pull_request",
      payload: {
        action: "closed",
        pull_request: { head: { ref: "agent/issue-42" } },
      },
    });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("agent PR");
  });

  test("pull_request closed without merge on agent branch skips", () => {
    const d = decideTrigger({
      eventName: "pull_request",
      payload: {
        action: "closed",
        pull_request: {
          head: { ref: "agent/issue-38" },
          merged: false,
        },
      },
    });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("closed without merge");
  });

  test("pull_request closed with merge on agent branch still runs", () => {
    const d = decideTrigger({
      eventName: "pull_request",
      payload: {
        action: "closed",
        pull_request: {
          head: { ref: "agent/issue-38" },
          merged: true,
        },
      },
    });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("agent PR");
  });

  test("pull_request on non-agent branch skips", () => {
    const d = decideTrigger({
      eventName: "pull_request",
      payload: {
        action: "closed",
        pull_request: { head: { ref: "feature/foo" } },
      },
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("non-agent pull request");
  });

  test("workflow_run on agent branch runs and surfaces conclusion", () => {
    const d = decideTrigger({
      eventName: "workflow_run",
      payload: {
        workflow_run: {
          head_branch: "agent/issue-7",
          conclusion: "success",
        },
      },
    });
    expect(d.run).toBe(true);
    expect(d.reason).toBe("agent CI success");
  });

  test("workflow_run on non-agent branch skips", () => {
    const d = decideTrigger({
      eventName: "workflow_run",
      payload: { workflow_run: { head_branch: "main", conclusion: "success" } },
    });
    expect(d.run).toBe(false);
  });

  test("custom agentBranchPrefix is honored", () => {
    const d = decideTrigger({
      eventName: "pull_request",
      payload: { pull_request: { head: { ref: "bot/work-12" } } },
      agentBranchPrefix: "bot/work-",
    });
    expect(d.run).toBe(true);
  });

  test("unknown event skips", () => {
    const d = decideTrigger({ eventName: "fork", payload: {} });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("unhandled");
  });

  test("malformed payloads are tolerated", () => {
    expect(
      decideTrigger({ eventName: "pull_request", payload: {} }).run,
    ).toBe(false);
    expect(
      decideTrigger({
        eventName: "workflow_run",
        payload: { workflow_run: null as unknown as Record<string, unknown> },
      }).run,
    ).toBe(false);
    expect(
      decideTrigger({
        eventName: "issues",
        payload: { action: "opened", issue: { labels: "nope" } },
      }).run,
    ).toBe(false);
  });
});
