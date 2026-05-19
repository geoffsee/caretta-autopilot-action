import { describe, expect, mock, test } from "bun:test";
import { GitHubActionsRuntime } from "../packages/action-common/src/action-runtime.js";

mock.module("@actions/core", () => ({
  getInput: mock(() => ""),
  getBooleanInput: mock(() => false),
  setOutput: mock(() => {}),
  setFailed: mock(() => {}),
  info: mock(() => {}),
  warning: mock(() => {}),
  setSecret: mock(() => {}),
  addPath: mock(() => {}),
  summary: {
    addRaw() {
      return this;
    },
    async write() {},
  },
}));

describe("GitHubActionsRuntime", () => {
  test("delegates setFailed, warning, and setSecret to @actions/core", async () => {
    const core = await import("@actions/core");
    const rt = new GitHubActionsRuntime();

    rt.setFailed("boom");
    expect(core.setFailed).toHaveBeenCalledWith("boom");

    rt.warning("careful");
    expect(core.warning).toHaveBeenCalledWith("careful");

    rt.setSecret("hunter2");
    expect(core.setSecret).toHaveBeenCalledWith("hunter2");
  });

  test("delegates getInput, getBooleanInput, setOutput, info, and addPath", async () => {
    const core = await import("@actions/core");
    (core.getInput as ReturnType<typeof mock>).mockReturnValueOnce("token");
    (core.getBooleanInput as ReturnType<typeof mock>).mockReturnValueOnce(true);

    const rt = new GitHubActionsRuntime();
    expect(rt.getInput("github-token", { required: true })).toBe("token");
    expect(core.getInput).toHaveBeenCalledWith("github-token", {
      required: true,
    });

    expect(rt.getBooleanInput("dry-run")).toBe(true);
    expect(core.getBooleanInput).toHaveBeenCalledWith("dry-run");

    rt.setOutput("route", "factory");
    expect(core.setOutput).toHaveBeenCalledWith("route", "factory");

    rt.info("hello");
    expect(core.info).toHaveBeenCalledWith("hello");

    rt.addPath("/opt/bin");
    expect(core.addPath).toHaveBeenCalledWith("/opt/bin");
  });

  test("exposes core.summary for step summaries", async () => {
    const core = await import("@actions/core");
    const rt = new GitHubActionsRuntime();
    expect(rt.summary).toBe(core.summary);
    await rt.summary.addRaw("### Notes\n").write();
  });
});
