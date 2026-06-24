import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  EvaluationResult,
  PullRequestReview,
} from "@caretta/action-common/types";
import {
  type ExecuteDeps,
  executeAutopilot,
} from "../src/application/execute-autopilot.js";
import {
  FakeExec,
  FakeGitHub,
  makeConfig,
  makeIssue,
  makeMergedPR,
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
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    exec = new FakeExec();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

  test("factory route fetches context from resolved geodynamo URL", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      fetchCalls.push(input.toString());
      return new Response(
        JSON.stringify({
          repo: "acme/widgets",
          context: "factory context from geodynamo",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const gh = new FakeGitHub({
      issues: [makeIssue({ number: 9, labels: [{ name: "sprint" }] })],
    });
    await executeAutopilot(
      gh,
      exec,
      makeConfig({
        repository: "acme/widgets",
        geodynamoUrl: "https://example.test/geodynamo/",
      }),
      factoryEval,
      fakeInstallDeps,
    );

    expect(fetchCalls).toEqual([
      "https://example.test/geodynamo/contexts/widgets/context.json",
    ]);
    const housekeeping = exec.calls.find((c) =>
      c.args.includes("housekeeping"),
    );
    expect(housekeeping?.options?.env?.CARETTA_CONTEXT).toBe(
      "test context\n\nfactory context from geodynamo",
    );
  });

  test("work route does not fetch geodynamo context", async () => {
    const fetchMock = mock(async () => {
      throw new Error("work route must not fetch geodynamo context");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const gh = new FakeGitHub();
    exec.stdout = "[]";

    await executeAutopilot(
      gh,
      exec,
      makeConfig({
        repository: "acme/widgets",
        geodynamoUrl: "https://example.test/geodynamo/",
      }),
      workEval,
      fakeInstallDeps,
    );

    expect(fetchMock).not.toHaveBeenCalled();
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

  test("work dispatch runs fix-pr (not code-review) when CI failed", async () => {
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

    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(false);
  });

  test("work dispatch runs fix-pr (not code-review) when CI failed, even if a stale bot review exists", async () => {
    // The stale review is irrelevant; failing CI is its own remediation signal
    // and reviewing broken code makes no sense.
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

    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(true);
    expect(exec.calls.some((c) => c.args.includes("code-review"))).toBe(false);
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

  test("failing CI invokes fix-pr only — never code-review on broken code", async () => {
    // Reviewing failing code is pointless: there's nothing to approve. The
    // action must run fix-pr (to remediate) and NOT code-review (which on
    // current SHAs would either be wasted compute or — worse — produce an
    // APPROVED review on broken code).
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 401,
          headRefName: "agent/issue-401",
          headRefOid: "sha-401",
        }),
      ],
      checksBySha: {
        "sha-401": [
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
    exec.stdout = JSON.stringify([401]);

    await executeAutopilot(
      gh,
      exec,
      makeConfig({ enableDispatch: false }),
      workEval,
      fakeInstallDeps,
    );

    expect(
      exec.calls.some(
        (c) => c.args.includes("fix-pr") && c.args.includes("401"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) => c.args.includes("code-review") && c.args.includes("401"),
      ),
    ).toBe(false);
  });

  test("passing CI with no fresh review invokes code-review only — fix-pr has nothing to fix", async () => {
    // The other half of the contract. With green CI and no review on the
    // head SHA, the action's job is to post a review so auto-merge can
    // proceed. Running fix-pr here pushes a commit for no reason and
    // dismisses any approval the very same tick would have produced —
    // the approval-invalidation loop observed on
    // geoffsee/autopilot-example-project PR #189.
    const reviewsByPr: Record<number, PullRequestReview[]> = { 402: [] };
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 402,
          headRefName: "agent/issue-402",
          headRefOid: "sha-402",
        }),
      ],
      checksBySha: {
        "sha-402": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
      },
      reviewsByPr,
    });
    exec.stdout = JSON.stringify([402]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(
      exec.calls.some(
        (c) => c.args.includes("code-review") && c.args.includes("402"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) => c.args.includes("fix-pr") && c.args.includes("402"),
      ),
    ).toBe(false);
  });

  test("passing CI + CHANGES_REQUESTED at head SHA invokes fix-pr only", async () => {
    // CHANGES_REQUESTED is the explicit "remediation needed" signal even
    // when CI is green. fix-pr addresses the requested changes; code-review
    // doesn't run because the just-completed review's verdict already
    // stands at the head SHA — re-reviewing now would either no-op or
    // produce a contradicting verdict.
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 403,
          headRefName: "agent/issue-403",
          headRefOid: "sha-403",
        }),
      ],
      checksBySha: {
        "sha-403": [
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
        403: [
          {
            state: "CHANGES_REQUESTED",
            body: "Please address the SSRF bypass",
            commitId: "sha-403",
            user: "caretta-autopilot[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([403]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(
      exec.calls.some(
        (c) => c.args.includes("fix-pr") && c.args.includes("403"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) => c.args.includes("code-review") && c.args.includes("403"),
      ),
    ).toBe(false);
  });

  test("DISMISSED review counts as no review at head SHA — code-review runs, fix-pr does not", async () => {
    // DISMISSED reviews are filtered out of the head-SHA review check, so the
    // PR looks unreviewed. Passing CI + no fresh review → code-review only.
    // fix-pr has no remediation signal (no failing CI, no CHANGES_REQUESTED).
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
    expect(exec.calls.some((c) => c.args.includes("fix-pr"))).toBe(false);
  });

  test("work dispatch fires CI after automerge-queue advances the branch tip", async () => {
    const pr = makePR({
      number: 501,
      headRefName: "agent/issue-501",
      headRefOid: "sha-501-original",
      mergeStateStatus: "BLOCKED",
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
      // current head SHA, so neither shouldRunCodeReview nor shouldRunFixPr
      // fires and the review/fix loop is skipped. The only remaining step
      // that can unstick the PR is the automerge-queue invocation.
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
      message: "Pull request is in clean status",
    };
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(gh.enableAutoMergeCalls).toContain(300);
    expect(gh.mergedPrs.map((m) => m.prNumber)).toContain(300);
  });

  // Stacked merges must progress from the deepest leaf inward. When both a
  // parent-on-default-branch PR and a child stacked on that parent's head are
  // queued, only the child's auto-merge fires this tick — the parent's head is
  // still the child's merge base.
  test("stacked queue: enables auto-merge on leaf child while holding open parent", async () => {
    const passingTest = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "2026-01-01T00:00:00Z",
      createdAt: null,
    };
    const approve = (sha: string) =>
      [
        {
          state: "APPROVED",
          body: "lgtm",
          commitId: sha,
          user: "caretta-ai[bot]",
        },
      ] as const;
    const parentPr = makePR({
      number: 161,
      headRefName: "agent/issue-155",
      headRefOid: "sha-161",
      baseRefName: "main",
      reviewDecision: "APPROVED",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const childPr = makePR({
      number: 162,
      headRefName: "agent/issue-156",
      headRefOid: "sha-162",
      baseRefName: "agent/issue-155",
      reviewDecision: "APPROVED",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [parentPr, childPr],
      checksBySha: {
        "sha-161": [passingTest],
        "sha-162": [passingTest],
      },
      reviewsByPr: {
        161: [...approve("sha-161")],
        162: [...approve("sha-162")],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(gh.enableAutoMergeCalls).not.toContain(161);
    expect(gh.enableAutoMergeCalls).toContain(162);
    expect(gh.mergedPrs.map((m) => m.prNumber)).not.toContain(161);
    expect(gh.mergedPrs.map((m) => m.prNumber)).not.toContain(162);
  });

  test("stacked queue: three-deep tracker — only deepest leaf gains auto-merge this tick", async () => {
    const passingTest = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "2026-01-01T00:00:00Z",
      createdAt: null,
    };
    const approve = (sha: string) =>
      [
        {
          state: "APPROVED",
          body: "lgtm",
          commitId: sha,
          user: "caretta-ai[bot]",
        },
      ] as const;
    const bottom = makePR({
      number: 10,
      headRefName: "agent/issue-10",
      headRefOid: "sha-10",
      baseRefName: "main",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const middle = makePR({
      number: 11,
      headRefName: "agent/issue-11",
      headRefOid: "sha-11",
      baseRefName: "agent/issue-10",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const leaf = makePR({
      number: 12,
      headRefName: "agent/issue-12",
      headRefOid: "sha-12",
      baseRefName: "agent/issue-11",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [bottom, middle, leaf],
      checksBySha: {
        "sha-10": [passingTest],
        "sha-11": [passingTest],
        "sha-12": [passingTest],
      },
      reviewsByPr: {
        10: [...approve("sha-10")],
        11: [...approve("sha-11")],
        12: [...approve("sha-12")],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(new Set(gh.enableAutoMergeCalls)).toEqual(new Set([12]));
    expect(gh.mergedPrs.map((m) => m.prNumber)).toHaveLength(0);
  });

  test("race regression: same tick enables stacked child auto-merge without touching blocked parent", async () => {
    const passingTest = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "2026-01-01T00:00:00Z",
      createdAt: null,
    };
    const approve = (sha: string) =>
      [
        {
          state: "APPROVED",
          body: "lgtm",
          commitId: sha,
          user: "caretta-ai[bot]",
        },
      ] as const;
    const parentPr = makePR({
      number: 401,
      headRefName: "agent/issue-400",
      headRefOid: "sha-401p",
      baseRefName: "main",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const childPr = makePR({
      number: 402,
      headRefName: "agent/issue-402",
      headRefOid: "sha-402",
      baseRefName: "agent/issue-400",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [parentPr, childPr],
      checksBySha: {
        "sha-401p": [passingTest],
        "sha-402": [passingTest],
      },
      reviewsByPr: {
        401: [...approve("sha-401p")],
        402: [...approve("sha-402")],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(gh.enableAutoMergeCalls).toEqual([402]);
    expect(gh.enableAutoMergeCalls).not.toContain(401);
  });

  test("stacked queue: CLEAN child with open parent → mergePullRequest, not enableAutoMerge", async () => {
    const passingTest = {
      name: "Test",
      status: "completed" as const,
      conclusion: "success" as const,
      startedAt: "2026-01-01T00:00:00Z",
      createdAt: null,
    };
    const parentPr = makePR({
      number: 501,
      headRefName: "agent/issue-500",
      headRefOid: "sha-501p",
      baseRefName: "main",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const childPr = makePR({
      number: 502,
      headRefName: "agent/issue-502",
      headRefOid: "sha-502",
      baseRefName: "agent/issue-500",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [parentPr, childPr],
      checksBySha: {
        "sha-501p": [passingTest],
        "sha-502": [passingTest],
      },
      reviewsByPr: {
        501: [],
        502: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-502",
            user: "caretta-ai[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(gh.enableAutoMergeCalls).not.toContain(502);
    expect(gh.mergedPrs.map((m) => m.prNumber)).toContain(502);
    expect(gh.mergedPrs.find((m) => m.prNumber === 502)?.method).toBe("SQUASH");
  });

  // Auto-rebase action item from
  // .dev/docs/post-mortems/2026-05-21-stuck-prs-tracker-matrix-empty-and-stacked-pr-retarget-failure.md
  // and 2026-05-21-branches-stale-from-missing-post-merge-deletion.md.
  //
  // A stacked agent PR whose parent has already squash-merged into the default
  // branch is the wedge shape PR #162 ended up in: its base ref points at a
  // branch that no longer matches anything reachable from main, so caretta's
  // retarget fails ("unable to align base to 'main'") and there is no
  // automated path back. The fix: when we detect this shape (parent
  // headRefName present in `listRecentlyMergedPullRequests` with baseRefName ==
  // defaultBranch), rebase the head onto main, replaying only commits above the
  // stacked base (`--onto origin/main origin/<baseRef>`), force-push with
  // lease, and retarget the PR via the GitHub API. After that the PR is just a
  // normal default-branch PR and the existing enableAutoMerge path picks it up.
  test("auto-rebase: stacked PR whose parent merged into default → rebase, force-push, retarget, then enable auto-merge", async () => {
    const stackedPr = makePR({
      number: 162,
      headRefName: "agent/issue-156",
      headRefOid: "sha-162",
      baseRefName: "agent/issue-155",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const parentMerged = makeMergedPR({
      number: 161,
      headRefName: "agent/issue-155",
      baseRefName: "main",
      body: "Closes #155",
    });
    const gh = new FakeGitHub({
      prs: [stackedPr],
      mergedPrs: [parentMerged],
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

    const gitCalls = exec.calls.filter((c) => c.command === "git");
    const args = gitCalls.map((c) => c.args.join(" "));
    expect(args.some((a) => a.startsWith("fetch origin main"))).toBe(true);
    expect(args).toContain("switch agent/issue-156");
    expect(args).toContain("rev-parse --verify origin/agent/issue-155");
    expect(args).toContain("rebase --onto origin/main origin/agent/issue-155");
    expect(
      args.some(
        (a) =>
          a.includes("push") &&
          a.includes("--force-with-lease") &&
          a.endsWith("agent/issue-156"),
      ),
    ).toBe(true);
    expect(gh.retargetCalls).toEqual([{ prNumber: 162, newBaseRef: "main" }]);
    expect(gh.enableAutoMergeCalls).toContain(162);
  });

  // Counterpart to the auto-rebase test: an open PR whose head matches the child's
  // stacked base pins the child's merge destination. Until the parent's head has
  // shipped via `main` (auto-rebase path), the autopilot merges the child into that
  // branch — without rebasing onto `main` or retargeting.
  test("stacked PR with open matching parent branch → merges into stacked base (no git rebase)", async () => {
    const openParentPr = makePR({
      number: 187,
      headRefName: "agent/issue-180",
      headRefOid: "sha-187",
      baseRefName: "main",
      reviewDecision: "APPROVED",
      mergeStateStatus: "BLOCKED",
      isAutoMergeEnabled: false,
    });
    const stackedChild = makePR({
      number: 189,
      headRefName: "agent/issue-182",
      headRefOid: "sha-189",
      baseRefName: "agent/issue-180",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const gh = new FakeGitHub({
      prs: [openParentPr, stackedChild],
      mergedPrs: [],
      checksBySha: {
        "sha-187": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: "2026-01-01T00:00:00Z",
            createdAt: null,
          },
        ],
        "sha-189": [
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
        187: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-187",
            user: "caretta-ai[bot]",
          },
        ],
        189: [
          {
            state: "APPROVED",
            body: "lgtm",
            commitId: "sha-189",
            user: "caretta-ai[bot]",
          },
        ],
      },
    });
    exec.stdout = JSON.stringify([]);

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    expect(exec.calls.some((c) => c.command === "git")).toBe(false);
    expect(gh.retargetCalls).toEqual([]);
    expect(gh.enableAutoMergeCalls).not.toContain(189);
    expect(gh.mergedPrs.map((m) => m.prNumber)).toContain(189);
  });

  // Conflict path: if `git rebase` fails (non-zero exit), the autopilot must
  // run `git rebase --abort`, keep the stacked base unchanged (no retarget),
  // and avoid enabling auto-merge in that tick.
  test("auto-rebase: rebase conflict → abort, no retarget, no enable", async () => {
    const stackedPr = makePR({
      number: 162,
      headRefName: "agent/issue-156",
      headRefOid: "sha-162",
      baseRefName: "agent/issue-155",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const parentMerged = makeMergedPR({
      number: 161,
      headRefName: "agent/issue-155",
      baseRefName: "main",
      body: "Closes #155",
    });
    const gh = new FakeGitHub({
      prs: [stackedPr],
      mergedPrs: [parentMerged],
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
    // Make `git rebase --onto origin/main origin/<base>` (NOT --abort)
    // return non-zero.
    exec.execHandler = (cmd, args) => {
      if (cmd !== "git") return 0;
      if (
        args[0] === "rebase" &&
        args[1] === "--onto" &&
        args[2] === "origin/main" &&
        args[3] === "origin/agent/issue-155"
      ) {
        return 1;
      }
      return 0;
    };

    await executeAutopilot(gh, exec, makeConfig(), workEval, fakeInstallDeps);

    const gitArgs = exec.calls
      .filter((c) => c.command === "git")
      .map((c) => c.args.join(" "));
    expect(gitArgs).toContain("rebase --abort");
    expect(
      gitArgs.some(
        (a) => a.includes("push") && a.includes("--force-with-lease"),
      ),
    ).toBe(false);
    expect(gh.retargetCalls).toEqual([]);
    expect(gh.enableAutoMergeCalls).not.toContain(162);
  });

  // Dry-run gate: the action item explicitly says auto-rebase must be gated
  // on `dryRun`. In dry-run mode we observe but never mutate; the rebase path
  // would force-push and retarget, both of which are write operations.
  test("auto-rebase: dryRun=true → no git ops, no retarget, no enable on stacked PR", async () => {
    const stackedPr = makePR({
      number: 162,
      headRefName: "agent/issue-156",
      headRefOid: "sha-162",
      baseRefName: "agent/issue-155",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      isAutoMergeEnabled: false,
    });
    const parentMerged = makeMergedPR({
      number: 161,
      headRefName: "agent/issue-155",
      baseRefName: "main",
      body: "Closes #155",
    });
    const gh = new FakeGitHub({
      prs: [stackedPr],
      mergedPrs: [parentMerged],
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

    await executeAutopilot(
      gh,
      exec,
      makeConfig({ dryRun: true }),
      workEval,
      fakeInstallDeps,
    );

    expect(exec.calls.some((c) => c.command === "git")).toBe(false);
    expect(gh.retargetCalls).toEqual([]);
    expect(gh.enableAutoMergeCalls).not.toContain(162);
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
    // Fallback finds the agent-branch PR with passing CI and no review →
    // code-review runs; fix-pr has no remediation signal.
    expect(
      exec.calls.some(
        (c) => c.args.includes("code-review") && c.args.includes("401"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (c) => c.args.includes("fix-pr") && c.args.includes("401"),
      ),
    ).toBe(false);
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
