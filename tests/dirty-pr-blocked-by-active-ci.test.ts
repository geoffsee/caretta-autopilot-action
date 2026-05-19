import { describe, expect, test } from "bun:test";
import type { ExecuteDeps } from "../src/application/execute-autopilot.js";
import { runAutopilot } from "../src/application/run-autopilot.js";
import {
  FakeExec,
  FakeGitHub,
  makeConfig,
  makeIssue,
  makePR,
} from "./fakes.js";

const fakeInstallDeps: ExecuteDeps = {
  installCaretta: async () => ({
    binaryPath: "/mock/caretta",
    version: "v1.2.3",
  }),
  installLinuxRuntimeDeps: async () => {},
  materializeBotPrivateKey: () => {},
  configureGitIdentity: async () => {},
  conflictResolverOptions: { intervalMs: 0, maxAttemptsPerPr: 1 },
};

// Regression: user reported running autopilot several times against this state
// without any branch ever updating:
//   PR #142 (agent/issue-136): mergeable=CONFLICTING, Test SUCCESS, REVIEW_REQUIRED
//   PR #141 (agent/issue-135): mergeable=MERGEABLE,   Test PENDING, APPROVED
// PR #142's conflicts must be resolved for the branch to advance, but the
// autopilot's hold-on-active-CI rule (PR #141) keeps executeAutopilot — and
// therefore ConflictResolver — from ever running.
describe("DIRTY agent PR stuck behind another PR's active CI", () => {
  test("fix-conflicts runs on the DIRTY PR even when another agent PR has Test PENDING", async () => {
    const exec = new FakeExec();
    const dirtyPr = makePR({
      number: 142,
      headRefName: "agent/issue-136",
      headRefOid: "sha-142",
      mergeStateStatus: "DIRTY",
      reviewDecision: "REVIEW_REQUIRED",
    });
    const pendingPr = makePR({
      number: 141,
      headRefName: "agent/issue-135",
      headRefOid: "sha-141",
      mergeStateStatus: "BLOCKED",
      reviewDecision: "APPROVED",
    });
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 200, labels: [{ name: "sprint" }] })],
      prs: [dirtyPr, pendingPr],
      checksBySha: {
        "sha-141": [
          {
            name: "Test",
            status: "in_progress",
            conclusion: null,
            startedAt: "2026-05-19T15:01:33Z",
            createdAt: "2026-05-19T15:01:33Z",
          },
        ],
        "sha-142": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-05-18T11:11:40Z",
            createdAt: "2026-05-18T11:11:40Z",
          },
        ],
      },
    });

    await runAutopilot(gh, exec, makeConfig(), "main", fakeInstallDeps);

    const fixConflictsCall = exec.calls.find(
      (c) => c.args.includes("fix-conflicts") && c.args.includes("142"),
    );
    expect(fixConflictsCall).toBeDefined();
  });
});
