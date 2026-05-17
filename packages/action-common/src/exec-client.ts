import * as exec from "@actions/exec";

export interface ExecClient {
  exec(
    commandLine: string,
    args?: string[],
    options?: exec.ExecOptions,
  ): Promise<number>;
  getExecOutput(
    commandLine: string,
    args?: string[],
    options?: exec.ExecOptions,
  ): Promise<exec.ExecOutput>;
}

export class DefaultExecClient implements ExecClient {
  async exec(
    commandLine: string,
    args?: string[],
    options?: exec.ExecOptions,
  ): Promise<number> {
    return await exec.exec(commandLine, args, options);
  }

  async getExecOutput(
    commandLine: string,
    args?: string[],
    options?: exec.ExecOptions,
  ): Promise<exec.ExecOutput> {
    return await exec.getExecOutput(commandLine, args, options);
  }
}
