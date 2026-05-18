import { describe, expect, test } from "bun:test";
import {
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
});
