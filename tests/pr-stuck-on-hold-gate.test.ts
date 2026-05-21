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
  ciGateIntervalMs: 0,
  ciGateTimeoutMs: 200,
};

// Regression: with the example repo in state
//   PR #142 (agent/issue-136): Test=SUCCESS, reviewDecision=REVIEW_REQUIRED
//   PR #141 (agent/issue-135): Test=FAILURE → autopilot reruns
// the user reported "PRs are not being updated" across many ticks. The hold
// gate (`decideExecution`) trips because `dispatched.length + active.length > 0`
// from `processAgentPRs`, so `executeAutopilot` is skipped — and `code-review`
// / `fix-pr` (which live inside `runWorkDispatch`) never run. The two tests
// below pin the expected behavior: the review/fix path must reach an agent PR
// even when (a) another agent PR has externally-active CI, or (b) the only
// blocker is autopilot's own rerun of the failing PR's CI.
describe("agent PR work-dispatch stuck behind hold-on-active-CI", () => {
  test("code-review runs on a passing+REVIEW_REQUIRED PR even when another agent PR has active Test CI", async () => {
    const exec = new FakeExec();
    const passingPr = makePR({
      number: 142,
      headRefName: "agent/issue-136",
      headRefOid: "sha-142",
      reviewDecision: "REVIEW_REQUIRED",
    });
    const otherActivePr = makePR({
      number: 141,
      headRefName: "agent/issue-135",
      headRefOid: "sha-141",
      reviewDecision: "APPROVED",
    });
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [passingPr, otherActivePr],
      checksBySha: {
        "sha-142": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-05-19T15:01:00Z",
            createdAt: "2026-05-19T15:01:00Z",
          },
        ],
        "sha-141": [
          {
            name: "Test",
            status: "in_progress",
            conclusion: null,
            startedAt: "2026-05-19T16:18:48Z",
            createdAt: "2026-05-19T16:18:48Z",
          },
        ],
      },
    });

    exec.stdout = JSON.stringify([135, 136]);
    await runAutopilot(gh, exec, makeConfig(), "main", fakeInstallDeps);

    const codeReview = exec.calls.find(
      (c) => c.args.includes("code-review") && c.args.includes("142"),
    );
    expect(codeReview).toBeDefined();
  });

  test("fix-pr runs on a failing-CI agent PR even though autopilot just re-dispatched its CI", async () => {
    const exec = new FakeExec();
    const failingPr = makePR({
      number: 141,
      headRefName: "agent/issue-135",
      headRefOid: "sha-141",
      reviewDecision: "APPROVED",
      mergeStateStatus: "BLOCKED",
    });
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 50, labels: [{ name: "sprint" }] })],
      prs: [failingPr],
      checksBySha: {
        "sha-141": [
          {
            name: "Test",
            status: "completed",
            conclusion: "failure",
            startedAt: "2026-05-19T16:00:00Z",
            createdAt: "2026-05-19T16:00:00Z",
          },
        ],
      },
    });

    exec.stdout = JSON.stringify([135]);
    const result = await runAutopilot(
      gh,
      exec,
      makeConfig(),
      "main",
      fakeInstallDeps,
    );

    // processAgentPRs no longer re-dispatches CI on a SHA whose named check
    // already concluded — it reconciles the stale pending commit status and
    // buckets the PR into `failed`. This is the inverse of the original bug:
    // `dispatched`/`active` stay empty, the hold gate does not trip, and
    // `reviewAndFixAgentPRs` reaches `fix-pr` without depending on the gate.
    expect(result.prCi.dispatched).toHaveLength(0);
    expect(result.prCi.failed.map((p) => p.number)).toEqual([141]);

    const fixPr = exec.calls.find(
      (c) => c.args.includes("fix-pr") && c.args.includes("141"),
    );
    expect(fixPr).toBeDefined();
  });
});
