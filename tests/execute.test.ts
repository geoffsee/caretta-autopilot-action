import { beforeEach, describe, expect, test } from "bun:test";
import type { EvaluationResult } from "../packages/action-common/src/types.js";
import {
  type ExecuteDeps,
  executeAutopilot,
} from "../src/application/execute-autopilot.js";
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
  conflictResolverOptions: {
    intervalMs: 0,
    timeoutMs: 60_000,
    maxAttemptsPerPr: 1,
  },
};

const workEval: EvaluationResult = {
  route: "work",
  sprint: 7,
  openIssueCount: 0,
  openPrCount: 0,
  stalePrCount: 0,
  tracker: "7",
  reason: "",
  activeSprint: "#7",
};

const factoryEval: EvaluationResult = {
  ...workEval,
  route: "factory",
  sprint: null,
  tracker: "",
  activeSprint: "none",
};

const unknownEval = {
  ...workEval,
  route: "other" as unknown as EvaluationResult["route"],
  tracker: "",
};

describe("executeAutopilot", () => {
  let exec: FakeExec;

  beforeEach(() => {
    exec = new FakeExec();
  });

  test("no-op when route matches neither work nor factory", async () => {
    const gh = new FakeGitHub();
    await executeAutopilot(
      gh,
      exec,
      makeConfig(),
      unknownEval,
      fakeInstallDeps,
    );
    expect(exec.calls).toHaveLength(0);
    expect(gh.dispatched).toHaveLength(0);
  });

  test("configures git identity and propagates it to caretta subprocess env", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
    });
    const identityCalls: Array<{ name: string; email: string }> = [];
    await executeAutopilot(
      gh,
      exec,
      makeConfig({
        gitUserName: "bot-name",
        gitUserEmail: "bot@example.com",
      }),
      factoryEval,
      {
        ...fakeInstallDeps,
        configureGitIdentity: async (name, email) => {
          identityCalls.push({ name, email });
        },
      },
    );

    expect(identityCalls).toEqual([
      { name: "bot-name", email: "bot@example.com" },
    ]);

    const housekeeping = exec.calls.find((c) =>
      c.args.includes("housekeeping"),
    );
    expect(housekeeping?.options?.env?.GIT_AUTHOR_NAME).toBe("bot-name");
    expect(housekeeping?.options?.env?.GIT_AUTHOR_EMAIL).toBe(
      "bot@example.com",
    );
    expect(housekeeping?.options?.env?.GIT_COMMITTER_NAME).toBe("bot-name");
    expect(housekeeping?.options?.env?.GIT_COMMITTER_EMAIL).toBe(
      "bot@example.com",
    );
  });

  test("propagates github-token to caretta subprocess env as GH_TOKEN", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
    });
    await executeAutopilot(
      gh,
      exec,
      makeConfig({ githubToken: "resolved-input-token" }),
      factoryEval,
      fakeInstallDeps,
    );
    const housekeeping = exec.calls.find((c) =>
      c.args.includes("housekeeping"),
    );
    expect(housekeeping?.args[0]).toBe("--auto");
    expect(housekeeping?.options?.env?.GH_TOKEN).toBe("resolved-input-token");
    expect(housekeeping?.options?.env?.GITHUB_TOKEN).toBe(
      "resolved-input-token",
    );
  });

  test("factory cycle skips ideation when an open 'sprint' issue exists", async () => {
    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
    });
    await executeAutopilot(
      gh,
      exec,
      makeConfig(),
      factoryEval,
      fakeInstallDeps,
    );

    expect(exec.calls.some((c) => c.args.includes("housekeeping"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("ideation"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("report-research"))).toBe(
      false,
    );
    expect(exec.calls.some((c) => c.args.includes("strategic-review"))).toBe(
      false,
    );
    expect(exec.calls.some((c) => c.args.includes("sprint-planning"))).toBe(
      false,
    );
  });

  test("work dispatch runs fix-conflicts on DIRTY agent-branch PRs", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 201,
          headRefName: "agent/issue-201",
          mergeStateStatus: "DIRTY",
        }),
      ],
      checksBySha: {
        "sha-201": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([201]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    const fixCalls = exec.calls.filter((c) => c.args.includes("fix-conflicts"));
    expect(fixCalls.length).toBeGreaterThanOrEqual(1);
    expect(fixCalls[0].args).toContain("201");
    // DIRTY PR must not reach code-review / fix-pr
    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(false);
  });

  test("work dispatch includes code-review/fix-pr even if CI failed", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 301, headRefName: "agent/issue-301" })],
      checksBySha: {
        "sha-301": [
          {
            name: "Test",
            status: "completed",
            conclusion: "failure",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([301]);

    await executeAutopilot(
      gh,
      exec,
      makeConfig({ enableDispatch: false }),
      workEval,
      fakeInstallDeps,
    );

    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(true);
  });

  test("work dispatch does not skip code-review/fix-pr if CI failed, even if a valid review exists", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 302,
          headRefName: "agent/issue-302",
          headRefOid: "sha-302",
        }),
      ],
      checksBySha: {
        "sha-302": [
          {
            name: "Test",
            status: "completed",
            conclusion: "failure",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      reviewsByPr: {
        302: [
          {
            state: "COMMENTED",
            body: "Looks good but failing CI",
            commitId: "sha-302",
            user: "caretta-autopilot[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([302]);

    await executeAutopilot(
      gh,
      exec,
      makeConfig({ enableDispatch: false }),
      workEval,
      fakeInstallDeps,
    );

    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(true);
  });

  test("runCiGate waits if ANY check is active, even if a completed one exists", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 304,
          headRefName: "agent/issue-304",
          headRefOid: "sha-304",
        }),
      ],
      checksBySha: {
        "sha-304": [
          {
            name: "Test",
            status: "completed",
            conclusion: "failure",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            name: "Test",
            status: "in_progress",
            conclusion: null,
            startedAt: "2026-01-01T00:01:00Z",
            createdAt: "2026-01-01T00:01:00Z",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([304]);

    const start = Date.now();
    // Configure CI gate to timeout quickly for the test
    const depsWithShortTimeout: ExecuteDeps = {
      ...fakeInstallDeps,
      ciGateTimeoutMs: 100,
      ciGateIntervalMs: 10,
    };

    await executeAutopilot(
      gh,
      exec,
      makeConfig(),
      workEval,
      depsWithShortTimeout,
    );
    const duration = Date.now() - start;

    expect(duration).toBeGreaterThanOrEqual(100);
    // Since it timed out, it should have logged a warning and continued.
    // We can verify that it didn't run code-review/fix-pr because latestCheck is null (still in_progress)
    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(false);
  });

  test("runCiGate synchronizes background workflow completion to PR status", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 305,
          headRefName: "agent/issue-305",
          headRefOid: "sha-305",
        }),
      ],
      checksBySha: {
        "sha-305": [
          {
            name: "Test",
            status: "in_progress",
            conclusion: null,
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
      runsByKey: {
        "ci.yml|any|agent/issue-305": [
          {
            id: 999,
            headSha: "sha-305",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([305]);

    // Use a short timeout so the loop doesn't block too long
    const deps: ExecuteDeps = {
      ...fakeInstallDeps,
      ciGateTimeoutMs: 200,
      ciGateIntervalMs: 50,
    };

    await executeAutopilot(gh, exec, makeConfig(), workEval, deps);

    // When the check run is still in_progress but the CI workflow for this SHA
    // already completed, dispatchMissingCi does not start another run; runCiGate
    // synchronizes the PR status from the completed workflow.
    const shaStatuses = gh.createdStatuses.filter(
      (s) => s.sha === "sha-305" && s.context === "Test",
    );
    expect(shaStatuses).toHaveLength(1);

    expect(shaStatuses[0].state).toBe("success");
    expect(shaStatuses[0].description).toContain(
      "Autopilot synchronized from run 999",
    );
  });

  test("work dispatch skips code-review/fix-pr if a valid review exists for the current SHA", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 302,
          headRefName: "agent/issue-302",
          headRefOid: "sha-302",
        }),
      ],
      checksBySha: {
        "sha-302": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      reviewsByPr: {
        302: [
          {
            state: "COMMENTED",
            body: "Looks good but here's a nit",
            commitId: "sha-302",
            user: "caretta-autopilot[bot]", // Should match github config default or hardcoded string
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([302]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(false);
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(false);

    const syncCalls = exec.calls.filter((c) =>
      c.args.includes("--sync-branches"),
    );
    expect(syncCalls.length).toBe(1); // Only the pre-review sync should run
  });

  test("work dispatch does not skip code-review/fix-pr if the existing review is DISMISSED", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 303,
          headRefName: "agent/issue-303",
          headRefOid: "sha-303",
        }),
      ],
      checksBySha: {
        "sha-303": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      reviewsByPr: {
        303: [
          {
            state: "DISMISSED",
            body: "Dismissed review",
            commitId: "sha-303",
            user: "caretta-autopilot[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([303]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(true);
  });

  test("work dispatch fires CI after automerge-queue advances the branch tip", async () => {
    const pr = makePR({
      number: 501,
      headRefName: "agent/issue-501",
      headRefOid: "sha-501-original",
    });
    const passingTest = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "2026-01-01T00:00:00Z",
      createdAt: null,
    };
    const gh = new FakeGitHub({
      prs: [pr],
      checksBySha: {
        "sha-501-original": [passingTest],
        // sha-501-advanced intentionally has no Test check — emulates the
        // post-update-branch state that auto-merge then waits on forever.
      },
    });
    exec.stdout = JSON.stringify([501]);

    // Simulate caretta's `auto-merge --automerge-queue` advancing the PR tip
    // via `gh pr update-branch`.
    const origExec = exec.exec.bind(exec);
    exec.exec = async (cmd, args, opts) => {
      const ret = await origExec(cmd, args, opts);
      if (args?.includes("auto-merge") && args.includes("--automerge-queue")) {
        (pr as { headRefOid: string }).headRefOid = "sha-501-advanced";
      }
      return ret;
    };

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    const dispatches = gh.dispatched.filter(
      (d) => d.ref === "agent/issue-501" && d.workflow === "ci.yml",
    );
    expect(dispatches.length).toBeGreaterThanOrEqual(1);
    // The dispatch must happen after caretta enters --automerge-queue (which
    // is the only thing in this test that mutates the tip to a check-less SHA).
    const automergeQueueIdx = exec.calls.findIndex(
      (c) =>
        c.args.includes("auto-merge") && c.args.includes("--automerge-queue"),
    );
    expect(automergeQueueIdx).toBeGreaterThanOrEqual(0);
  });

  test("work dispatch skips automerge-queue if all queued PRs have auto-merge already enabled", async () => {
    const pr = makePR({
      number: 601,
      headRefName: "agent/issue-601",
      isAutoMergeEnabled: true,
    });
    const gh = new FakeGitHub({
      prs: [pr],
      checksBySha: {
        "sha-601": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([601]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    const automergeQueueIdx = exec.calls.findIndex(
      (c) =>
        c.args.includes("auto-merge") && c.args.includes("--automerge-queue"),
    );
    expect(automergeQueueIdx).toBe(-1); // Should not have been called
  });

  // Regression: 2026-05-21 wedge on geoffsee/autopilot-example-project where
  // PRs #159 and #162 sat APPROVED + CLEAN + Test:SUCCESS for ~22 hours with
  // `autoMergeRequest: null`. Root cause: `tracker-matrix` returned `[]`
  // (caretta parser regression upstream), and runWorkDispatch gated the
  // automerge-queue invocation on `issueStringsAfterFix.length > 0`, so
  // `queuedPrs` collapsed to `[]` and `needsAutomerge` was vacuously false.
  // The autopilot logged "All tracker-scoped PRs already have auto-merge
  // enabled. Skipping automerge-queue." every tick (false on the facts, true
  // on the empty-set logic) and never enabled auto-merge.
  //
  // The fix shape: when `tracker-matrix` returns `[]`, the automerge gate
  // must still consider all open agent-branch PRs (same fallback as
  // `resolveTrackerScopedPrs`), and invoke `--automerge-queue` whenever any
  // open agent PR lacks `isAutoMergeEnabled`. The post-mortem lives at
  // .dev/docs/post-mortems/2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md.
  test("regression: empty tracker-matrix with a merge-ready agent PR lacking auto-merge → still invokes --automerge-queue", async () => {
    const pr = makePR({
      number: 159,
      headRefName: "agent/issue-153",
      headRefOid: "sha-159",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [pr],
      checksBySha: {
        "sha-159": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      // Match the production state: caretta-ai[bot] has already APPROVED the
      // current head SHA, so `agentPrNeedsReviewOrFix` returns false and the
      // review/fix loop is skipped. The only remaining step that can unstick
      // the PR is the automerge-queue invocation.
      reviewsByPr: {
        159: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-159",
            user: "caretta-ai[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([]); // tracker-matrix returns no pending issues

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    const automergeQueueIdx = exec.calls.findIndex(
      (c) =>
        c.args.includes("auto-merge") && c.args.includes("--automerge-queue"),
    );
    expect(automergeQueueIdx).toBeGreaterThanOrEqual(0);
  });

  // Companion to the regression above: even when ONE of the open agent PRs
  // already has auto-merge enabled, the autopilot must still call
  // `--automerge-queue` if at least one other open agent PR needs it. This
  // pins the "needsAutomerge = any open agent PR lacks auto-merge"
  // semantics, not "every queued PR was already enabled."
  test("regression: empty tracker-matrix with mixed auto-merge state → still invokes --automerge-queue when at least one PR lacks it", async () => {
    const prAlreadyEnabled = makePR({
      number: 159,
      headRefName: "agent/issue-153",
      headRefOid: "sha-159",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: true,
    });
    const prNeedsEnable = makePR({
      number: 162,
      headRefName: "agent/issue-156",
      headRefOid: "sha-162",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const passingTest = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "2026-01-01T00:00:00Z",
      createdAt: null,
    };
    const gh = new FakeGitHub({
      prs: [prAlreadyEnabled, prNeedsEnable],
      checksBySha: {
        "sha-159": [passingTest],
        "sha-162": [passingTest],
      },
      reviewsByPr: {
        159: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-159",
            user: "caretta-ai[bot]",
          },
        ],
        162: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-162",
            user: "caretta-ai[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    const automergeQueueIdx = exec.calls.findIndex(
      (c) =>
        c.args.includes("auto-merge") && c.args.includes("--automerge-queue"),
    );
    expect(automergeQueueIdx).toBeGreaterThanOrEqual(0);
  });

  // Second-order regression discovered after the JS-gate fix above shipped:
  // the autopilot invoked `caretta auto-merge --automerge-queue`, but caretta
  // itself bailed with `auto-merge (lineage): nothing scheduled after
  // deterministic ordering filtered to open PR rows.` because its lineage
  // path consults `pending_issues_execution_order` (the same parser as
  // tracker-matrix). PR #159 stayed at `autoMergeRequest: null` after the
  // next live tick (run `26230198916`) — so the JS gate firing isn't
  // sufficient on its own. The autopilot must enable auto-merge directly
  // via the GitHub API for merge-ready agent PRs, bypassing caretta's
  // broken lineage. See post-mortem
  // .dev/docs/post-mortems/2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md.
  //
  // Third-order regression discovered after the direct `enableAutoMerge` call
  // shipped: GitHub's `enablePullRequestAutoMerge` mutation rejects PRs in
  // `mergeStateStatus: CLEAN` with "Pull request is in clean status" because
  // it requires at least one pending condition to wait on. Run `26231855013`
  // emitted the rejection as a warning and left PR #159 wedged. The autopilot
  // must merge such PRs directly instead.
  test("regression: empty tracker-matrix with merge-ready CLEAN agent PR → autopilot calls mergePullRequest, not enableAutoMerge", async () => {
    const pr = makePR({
      number: 159,
      headRefName: "agent/issue-153",
      headRefOid: "sha-159",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [pr],
      checksBySha: {
        "sha-159": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      reviewsByPr: {
        159: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-159",
            user: "caretta-ai[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(gh.mergedPrs.map((m) => m.prNumber)).toContain(159);
    expect(gh.mergedPrs.find((m) => m.prNumber === 159)?.method).toBe("SQUASH");
    expect(gh.enableAutoMergeCalls).not.toContain(159);
  });

  // When the PR is still waiting on something (mergeStateStatus !== CLEAN),
  // `enableAutoMerge` is correct — GitHub will hold the merge until the
  // outstanding condition clears. Direct merge would error in that state.
  test("non-CLEAN merge-ready agent PR → autopilot calls enableAutoMerge (not mergePullRequest)", async () => {
    const pr = makePR({
      number: 200,
      headRefName: "agent/issue-200",
      headRefOid: "sha-200",
      reviewDecision: "APPROVED",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [pr],
      checksBySha: {
        "sha-200": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      reviewsByPr: {
        200: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-200",
            user: "caretta-ai[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(gh.enableAutoMergeCalls).toContain(200);
    expect(gh.mergedPrs.map((m) => m.prNumber)).not.toContain(200);
  });

  // Belt-and-suspenders: if `listOpenPullRequests` returned a stale
  // mergeStateStatus and the PR transitioned to CLEAN between the read and
  // the mutation, `enableAutoMerge` will reject with "Pull request is in
  // clean status". The autopilot must catch that specific error and fall
  // back to mergePullRequest rather than leaving the PR wedged.
  test("enableAutoMerge clean-status race → autopilot falls back to mergePullRequest", async () => {
    const pr = makePR({
      number: 300,
      headRefName: "agent/issue-300",
      headRefOid: "sha-300",
      reviewDecision: "APPROVED",
      // Read as BLOCKED; mutation will reject because the live state flipped
      // to CLEAN before the API call fired.
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [pr],
      checksBySha: {
        "sha-300": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      reviewsByPr: {
        300: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-300",
            user: "caretta-ai[bot]",
          },
        ],
      },
    });
    gh.enableAutoMergeErrorForPr = {
      prNumber: 300,
      message: "Pull request Pull request is in clean status",
    };
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(gh.enableAutoMergeCalls).toContain(300);
    expect(gh.mergedPrs.map((m) => m.prNumber)).toContain(300);
  });

  // Guard against the side effect of enabling auto-merge on a stacked PR.
  // PR #162 in the 2026-05-21 wedge has base=`agent/issue-155` (a still-alive
  // post-squash-merge branch). Enabling auto-merge directly via the API would
  // cause GitHub to merge #156's work into the dead `agent/issue-155` branch
  // — orphaning it off of main. The JS-direct path must enable auto-merge
  // only when `baseRefName === defaultBranch`; stacked PRs need their base
  // repaired (rebase + retarget) before they're safe to merge.
  test("guard: does NOT enable auto-merge on PRs whose base is not the default branch (stacked PRs)", async () => {
    const stackedPr = makePR({
      number: 162,
      headRefName: "agent/issue-156",
      headRefOid: "sha-162",
      baseRefName: "agent/issue-155",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [stackedPr],
      checksBySha: {
        "sha-162": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      reviewsByPr: {
        162: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-162",
            user: "caretta-ai[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(gh.enableAutoMergeCalls).not.toContain(162);
    expect(gh.mergedPrs.map((m) => m.prNumber)).not.toContain(162);
  });

  test("empty tracker-matrix: CI gate breaks early and resolveTrackerScopedPrs falls back to any agent-branch PR", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 401, headRefName: "agent/issue-401" })],
      checksBySha: {
        "sha-401": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    // Empty matrix → no per-issue caretta call
    expect(
      exec.calls.some(
        (c) => c.args.includes("issue") && c.args.includes("--tracker"),
      ),
    ).toBe(false);
    // Fallback finds the agent-branch PR with passing CI → code-review and fix-pr called
    expect(
      exec.calls.some(
        (c) => c.args.includes("code-review") && c.args.includes("401"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) => c.args.includes("fix-pr") && c.args.includes("401"),
      ),
    ).toBe(true);
  });

  // The BLOCKED-on-self-approval bug observed in production was caused by
  // 57d185e, which made the action mint a GitHub App installation token from
  // DEV_BOT_* creds and use it as ambient GH_TOKEN/GITHUB_TOKEN. Caretta's
  // review path independently mints from the same DEV_BOT_* creds, so both
  // `gh pr create` and `gh pr review` ran under the same `caretta-ai[bot]`
  // identity — GitHub does not count self-approvals.
  //
  // The 57d185e change was added on the theory that PRs created under
  // GITHUB_TOKEN don't trigger CI events and therefore can't satisfy the
  // required-check rollup. Empirically that theory is wrong for this repo:
  // pre-57d185e merged PRs (#50, #51, #53, #54, #97) all show a Test check
  // produced by `event: workflow_dispatch` (dispatchMissingCi in this action)
  // that *did* satisfy the rollup. So the App-mint detour was unnecessary;
  // reverting it restores two distinct identities (`github-actions[bot]`
  // creates, `caretta-ai[bot]` reviews) and PRs merge again.
  //
  // This test pins down the post-revert invariant: regardless of whether
  // DEV_BOT_* App creds are in the env, the caretta subprocess sees the
  // workflow's GITHUB_TOKEN as its ambient GH_TOKEN — not a minted App token.
  test("propagates the workflow GITHUB_TOKEN to the caretta subprocess, ignoring DEV_BOT_* App creds for ambient auth", async () => {
    const previousEnv = { ...process.env };
    process.env.DEV_BOT_APP_ID = "12345";
    process.env.DEV_BOT_PRIVATE_KEY = "/tmp/dev-bot.pem";
    process.env.DEV_BOT_INSTALLATION_ID = "99999";

    try {
      const gh = new FakeGitHub({
        issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
      });
      await executeAutopilot(
        gh,
        exec,
        makeConfig({ githubToken: "ghs_workflow_default" }),
        factoryEval,
        fakeInstallDeps,
      );

      const carettaCalls = exec.calls.filter(
        (c) => c.command === "/mock/caretta",
      );
      expect(carettaCalls.length).toBeGreaterThan(0);
      for (const call of carettaCalls) {
        const callEnv = (call.options?.env ?? {}) as Record<string, string>;
        expect(callEnv.GH_TOKEN).toBe("ghs_workflow_default");
        expect(callEnv.GITHUB_TOKEN).toBe("ghs_workflow_default");
      }
    } finally {
      process.env = previousEnv;
    }
  });
});
