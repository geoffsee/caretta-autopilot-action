import { describe, expect, test } from "bun:test";
import { dispatchMissingCi } from "../src/application/ci-dispatcher.js";
import { FakeGitHub, makeConfig, makePR } from "./fakes.js";

describe("dispatchMissingCi", () => {
  test("dispatches ci.yml for an agent PR with no Test check on its head SHA", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 101, headRefName: "agent/issue-101" })],
      checksBySha: { "sha-101": [] },
    });

    const result = await dispatchMissingCi(gh, makeConfig());

    expect(result.dispatched).toEqual([101]);
    expect(gh.dispatched).toEqual([
      { workflow: "ci.yml", ref: "agent/issue-101", inputs: undefined },
    ]);
    expect(gh.createdStatuses).toEqual([
      {
        sha: "sha-101",
        state: "pending",
        context: "Test",
        description: "Autopilot dispatching CI...",
        targetUrl: undefined,
      },
    ]);
  });

  test("dispatches ci.yml for an agent PR with a suffix in the branch name", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 101, headRefName: "agent/issue-101-fix" })],
      checksBySha: { "sha-101": [] },
    });

    const result = await dispatchMissingCi(gh, makeConfig());

    expect(result.dispatched).toEqual([101]);
    expect(gh.dispatched).toEqual([
      { workflow: "ci.yml", ref: "agent/issue-101-fix", inputs: undefined },
    ]);
  });

  test("skips PRs whose head SHA already has a Test check", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 102, headRefName: "agent/issue-102" })],
      checksBySha: {
        "sha-102": [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: null,
            createdAt: null,
          },
        ],
      },
    });

    const result = await dispatchMissingCi(gh, makeConfig());

    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toEqual([102]);
    expect(gh.dispatched).toEqual([]);
  });

  test("skips PRs that already have a queued or in_progress run at the same SHA", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 103, headRefName: "agent/issue-103" })],
      checksBySha: { "sha-103": [] },
      runsByKey: {
        "ci.yml|any|agent/issue-103": [
          { id: 1, headSha: "sha-103", status: "queued", conclusion: null },
        ],
      },
    });

    const result = await dispatchMissingCi(gh, makeConfig());

    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toEqual([103]);
    expect(gh.dispatched).toEqual([]);
  });

  test("ignores non-agent and draft PRs", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({
          number: 1,
          headRefName: "feature/manual",
        }),
        makePR({
          number: 2,
          headRefName: "agent/issue-2",
          isDraft: true,
        }),
      ],
      checksBySha: { "sha-1": [], "sha-2": [] },
    });

    const result = await dispatchMissingCi(gh, makeConfig());

    expect(result.dispatched).toEqual([]);
    expect(gh.dispatched).toEqual([]);
  });

  test("issueNumbers scope restricts to matching agent branches", async () => {
    const gh = new FakeGitHub({
      prs: [
        makePR({ number: 10, headRefName: "agent/issue-10" }),
        makePR({ number: 11, headRefName: "agent/issue-11" }),
      ],
      checksBySha: { "sha-10": [], "sha-11": [] },
    });

    const result = await dispatchMissingCi(gh, makeConfig(), {
      issueNumbers: [11],
    });

    expect(result.dispatched).toEqual([11]);
    expect(gh.dispatched.map((d) => d.ref)).toEqual(["agent/issue-11"]);
  });

  test("no-ops when dryRun is true", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 9, headRefName: "agent/issue-9" })],
      checksBySha: { "sha-9": [] },
    });

    const result = await dispatchMissingCi(gh, makeConfig({ dryRun: true }));

    expect(result.dispatched).toEqual([]);
    expect(gh.dispatched).toEqual([]);
  });

  test("no-ops when enableDispatch is false", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 9, headRefName: "agent/issue-9" })],
      checksBySha: { "sha-9": [] },
    });

    const result = await dispatchMissingCi(
      gh,
      makeConfig({ enableDispatch: false }),
    );

    expect(result.dispatched).toEqual([]);
    expect(gh.dispatched).toEqual([]);
  });

  test("reports failures without throwing", async () => {
    const gh = new FakeGitHub({
      prs: [makePR({ number: 50, headRefName: "agent/issue-50" })],
      checksBySha: { "sha-50": [] },
      dispatchShouldFail: () => true,
    });

    const result = await dispatchMissingCi(gh, makeConfig());

    expect(result.dispatched).toEqual([]);
    expect(result.failed).toEqual([50]);
    expect(gh.createdStatuses).toEqual([
      {
        sha: "sha-50",
        state: "error",
        context: "Test",
        description:
          "Autopilot CI dispatch failed: dispatch failed for ci.yml on agent/issue-50",
        targetUrl: undefined,
      },
    ]);
  });
});
