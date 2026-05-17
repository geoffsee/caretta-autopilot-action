import type { Mock } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: Mocking external modules requires any
type AnyMock = Mock<(...args: any[]) => any>;

import { describe, expect, it, mock } from "bun:test";
import * as actionsExec from "@actions/exec";
import { DefaultExecClient } from "../packages/action-common/src/exec-client.js";

mock.module("@actions/exec", () => ({
  exec: mock(),
  getExecOutput: mock(),
}));

describe("DefaultExecClient", () => {
  it("exec calls @actions/exec.exec", async () => {
    const client = new DefaultExecClient();
    (actionsExec.exec as AnyMock).mockResolvedValue(42);

    const result = await client.exec("ls", ["-l"], { cwd: "/tmp" });

    expect(result).toBe(42);
    expect(actionsExec.exec).toHaveBeenCalledWith("ls", ["-l"], {
      cwd: "/tmp",
    });
  });

  it("getExecOutput calls @actions/exec.getExecOutput", async () => {
    const client = new DefaultExecClient();
    const output = { exitCode: 0, stdout: "hello", stderr: "" };
    (actionsExec.getExecOutput as AnyMock).mockResolvedValue(output);

    const result = await client.getExecOutput("echo", ["hello"]);

    expect(result).toEqual(output);
    expect(actionsExec.getExecOutput).toHaveBeenCalledWith(
      "echo",
      ["hello"],
      undefined,
    );
  });
});
