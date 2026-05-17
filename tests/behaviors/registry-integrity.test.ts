/**
 * Guardrails for `contract-registry.ts` itself.
 */
import { describe, expect, test } from "bun:test";
import { BEHAVIOR_CONTRACTS, contractById } from "./contract-registry.js";

describe("behavior contract registry integrity", () => {
  test("contract ids are unique", () => {
    const ids = BEHAVIOR_CONTRACTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("contractById resolves every declared id", () => {
    for (const c of BEHAVIOR_CONTRACTS) {
      expect(contractById(c.id).statement).toBe(c.statement);
    }
  });
});
