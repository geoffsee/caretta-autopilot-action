import * as core from "@actions/core";

export interface SummaryWriter {
  addRaw(content: string): SummaryWriter;
  write(): Promise<unknown>;
}

export interface ActionRuntime {
  getInput(name: string, options?: { required?: boolean }): string;
  getBooleanInput(name: string): boolean;
  setOutput(name: string, value: unknown): void;
  setFailed(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  setSecret(secret: string): void;
  addPath(path: string): void;
  readonly summary: SummaryWriter;
}

export class GitHubActionsRuntime implements ActionRuntime {
  readonly summary: SummaryWriter = core.summary;

  getInput(name: string, options?: { required?: boolean }): string {
    return core.getInput(name, options);
  }

  getBooleanInput(name: string): boolean {
    return core.getBooleanInput(name);
  }

  setOutput(name: string, value: unknown): void {
    core.setOutput(name, value);
  }

  setFailed(message: string): void {
    core.setFailed(message);
  }

  info(message: string): void {
    core.info(message);
  }

  warning(message: string): void {
    core.warning(message);
  }

  setSecret(secret: string): void {
    core.setSecret(secret);
  }

  addPath(path: string): void {
    core.addPath(path);
  }
}
