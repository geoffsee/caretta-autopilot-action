import { describe, expect, test } from "bun:test";
import {
  activeRun,
  latestFailedRun,
  latestNamedCheck,
  matchesGateCheckName,
} from "../packages/action-common/src/check-runs.js";
import type { CheckRun } from "../packages/action-common/src/types.js";

describe("matchesGateCheckName", () => {
  test("exact match", () => {
    expect(matchesGateCheckName("Test", "Test")).toBe(true);
    expect(matchesGateCheckName("CI / Test", "CI / Test")).toBe(true);
  });

  test("Actions-style workflow / job name vs short gate", () => {
    expect(matchesGateCheckName("CI / Test", "Test")).toBe(true);
    expect(matchesGateCheckName("CI / Test", "ci")).toBe(false);
  });

  test("short check vs full gate (symmetric)", () => {
    expect(matchesGateCheckName("Test", "CI / Test")).toBe(true);
  });

  test("unrelated names", () => {
    expect(matchesGateCheckName("Lint", "Test")).toBe(false);
    expect(matchesGateCheckName("Contest", "Test")).toBe(false);
  });
});

describe("latestNamedCheck", () => {
  test("selects newest matching check when Actions uses CI / Test", () => {
    const checks: CheckRun[] = [
      {
        name: "CI / Test",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const latest = latestNamedCheck(checks, "Test");
    expect(latest?.name).toBe("CI / Test");
    expect(latest?.conclusion).toBe("success");
  });

  test("sorts by created/started time via checkTime helper path", () => {
    const checks: CheckRun[] = [
      {
        name: "Test",
        status: "completed",
        conclusion: "success",
        startedAt: null,
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        name: "CI / Test",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-01-02T00:00:00Z",
        createdAt: "",
      },
    ];
    const latest = latestNamedCheck(checks, "Test");
    expect(latest?.name).toBe("CI / Test");
  });
});

describe("latestFailedRun and activeRun", () => {
  test("latestFailedRun prefers highest id and matches non-success conclusions", () => {
    const failed = latestFailedRun([
      { id: 2, headSha: "a", status: "completed", conclusion: "success" },
      { id: 10, headSha: "b", status: "completed", conclusion: "failure" },
      { id: 5, headSha: "c", status: "completed", conclusion: "cancelled" },
    ]);
    expect(failed?.id).toBe(10);

    const cancelledOnly = latestFailedRun([
      { id: 1, headSha: "a", status: "completed", conclusion: "cancelled" },
    ]);
    expect(cancelledOnly?.conclusion).toBe("cancelled");

    const timed = latestFailedRun([
      { id: 3, headSha: "a", status: "completed", conclusion: "timed_out" },
    ]);
    expect(timed?.conclusion).toBe("timed_out");

    const active = activeRun([
      { id: 1, headSha: "a", status: "queued", conclusion: null },
    ]);
    expect(active?.status).toBe("queued");

    const inProg = activeRun([
      { id: 2, headSha: "a", status: "in_progress", conclusion: null },
    ]);
    expect(inProg?.status).toBe("in_progress");
  });
});
