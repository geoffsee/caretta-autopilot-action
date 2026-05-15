import type { Mock } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: Mocking external modules requires any
type AnyMock = Mock<(...args: any[]) => any>;

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";
import {
  configureGitIdentity,
  installCaretta,
  installLinuxRuntimeDeps,
  materializeBotPrivateKey,
  mintInstallationToken,
} from "../src/install.js";

mock.module("node:fs", () => ({
  existsSync: mock(),
  readFileSync: mock(),
  writeFileSync: mock(),
}));

mock.module("@actions/core", () => ({
  info: mock(),
  warning: mock(),
  addPath: mock(),
  setSecret: mock(),
}));

mock.module("@actions/exec", () => ({
  exec: mock(),
}));

mock.module("@actions/tool-cache", () => ({
  find: mock(),
  downloadTool: mock(),
  extractTar: mock(),
  cacheDir: mock(),
}));

// Mock global fetch
const _originalFetch = global.fetch;
global.fetch = mock() as unknown as typeof fetch;

describe("install.ts", () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  beforeEach(() => {
    (fs.existsSync as AnyMock).mockClear();
    (fs.readFileSync as AnyMock).mockClear();
    (fs.writeFileSync as AnyMock).mockClear();
    (core.info as AnyMock).mockClear();
    (core.warning as AnyMock).mockClear();
    (core.addPath as AnyMock).mockClear();
    (core.setSecret as AnyMock).mockClear();
    (exec.exec as AnyMock).mockClear();
    (tc.find as AnyMock).mockClear();
    (tc.downloadTool as AnyMock).mockClear();
    (tc.extractTar as AnyMock).mockClear();
    (tc.cacheDir as AnyMock).mockClear();
    (global.fetch as unknown as AnyMock).mockClear();

    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    Object.defineProperty(process, "arch", {
      value: "x64",
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    Object.defineProperty(process, "arch", { value: originalArch });
  });

  describe("installCaretta", () => {
    it("installs a specific version on Linux x64 when not cached", async () => {
      (tc.find as AnyMock).mockReturnValue("");
      (tc.downloadTool as AnyMock).mockResolvedValue("/tmp/tarball");
      (tc.extractTar as AnyMock).mockResolvedValue("/tmp/extracted");
      (tc.cacheDir as AnyMock).mockResolvedValue("/tmp/cached");
      (exec.exec as AnyMock).mockResolvedValue(0);

      const result = await installCaretta("v1.0.0", "token");

      expect(result.version).toBe("v1.0.0");
      expect(tc.downloadTool).toHaveBeenCalled();
      expect(tc.extractTar).toHaveBeenCalled();
      expect(tc.cacheDir).toHaveBeenCalled();
      expect(exec.exec).toHaveBeenCalledWith("chmod", [
        "+x",
        expect.stringContaining("caretta"),
      ]);
      expect(core.addPath).toHaveBeenCalled();
    });

    it("uses cached version if available", async () => {
      (tc.find as AnyMock).mockReturnValue("/cached/path");

      const result = await installCaretta("v1.0.0", "token");

      expect(result.version).toBe("v1.0.0");
      expect(result.binaryPath).toBe("/cached/path/caretta");
      expect(tc.downloadTool).not.toHaveBeenCalled();
    });

    it("resolves 'latest' version and handles manifest", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "arch", { value: "arm64" });
      (fs.existsSync as AnyMock).mockReturnValue(false);
      (global.fetch as unknown as AnyMock).mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v2.0.0" }),
      });
      (tc.find as AnyMock).mockReturnValue("");
      (tc.downloadTool as AnyMock).mockResolvedValue("/tmp/tarball");
      (tc.extractTar as AnyMock).mockResolvedValue("/tmp/extracted");
      (tc.cacheDir as AnyMock).mockResolvedValue("/tmp/cached");

      const result = await installCaretta("latest", "token");

      expect(result.version).toBe("v2.0.0");
      expect(fs.writeFileSync).toHaveBeenCalled(); // manifest saved
    });

    it("upgrades from cached latest if new release available", async () => {
      (fs.existsSync as AnyMock).mockReturnValue(true);
      (fs.readFileSync as AnyMock).mockReturnValue(
        JSON.stringify({
          resolvedVersion: "v1.0.0",
          cachedAt: new Date().toISOString(),
          platform: "x86_64-linux",
        }),
      );
      (global.fetch as unknown as AnyMock).mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v1.1.0" }),
      });
      (tc.find as AnyMock).mockReturnValue("");
      (tc.downloadTool as AnyMock).mockResolvedValue("/tmp/tarball");
      (tc.extractTar as AnyMock).mockResolvedValue("/tmp/extracted");
      (tc.cacheDir as AnyMock).mockResolvedValue("/tmp/cached");

      const result = await installCaretta("latest", "token");

      expect(result.version).toBe("v1.1.0");
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Upgrading"),
      );
    });

    it("throws error for unsupported OS", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      await expect(installCaretta("v1.0.0", "token")).rejects.toThrow(
        "Unsupported OS",
      );
    });

    it("handles version input with or without 'v' prefix", async () => {
      (tc.find as AnyMock).mockReturnValue("/cached/path");

      const res1 = await installCaretta("1.2.3", "token");
      expect(res1.version).toBe("v1.2.3");

      const res2 = await installCaretta("v1.2.3", "token");
      expect(res2.version).toBe("v1.2.3");
    });

    it("throws error if latest release fetch fails", async () => {
      (fs.existsSync as AnyMock).mockReturnValue(false);
      (global.fetch as unknown as AnyMock).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });
      await expect(installCaretta("latest", "token")).rejects.toThrow(
        "Failed to resolve latest caretta release",
      );
    });

    it("handles corrupted manifest", async () => {
      (fs.existsSync as AnyMock).mockReturnValue(true);
      (fs.readFileSync as AnyMock).mockImplementation(() => {
        throw new Error("corrupted");
      });
      (global.fetch as unknown as AnyMock).mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v2.0.0" }),
      });
      (tc.find as AnyMock).mockReturnValue("/cached/path");

      const result = await installCaretta("latest", "token");
      expect(result.version).toBe("v2.0.0");
    });

    it("handles checkNewReleaseAvailable failure gracefully", async () => {
      (fs.existsSync as AnyMock).mockReturnValue(true);
      (fs.readFileSync as AnyMock).mockReturnValue(
        JSON.stringify({
          resolvedVersion: "v1.0.0",
          cachedAt: new Date().toISOString(),
          platform: "x86_64-linux",
        }),
      );
      (global.fetch as unknown as AnyMock).mockRejectedValue(
        new Error("network error"),
      );
      (tc.find as AnyMock).mockReturnValue("/cached/path");

      const result = await installCaretta("latest", "token");
      expect(result.version).toBe("v1.0.0");
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to check for new releases"),
      );
    });

    it("logs when using cached latest version without upgrade", async () => {
      (fs.existsSync as AnyMock).mockReturnValue(true);
      (fs.readFileSync as AnyMock).mockReturnValue(
        JSON.stringify({
          resolvedVersion: "v1.0.0",
          cachedAt: new Date().toISOString(),
          platform: "x86_64-linux",
        }),
      );
      (global.fetch as unknown as AnyMock).mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: "v1.0.0" }),
      });
      (tc.find as AnyMock).mockReturnValue("/cached/path");

      const result = await installCaretta("latest", "token");
      expect(result.version).toBe("v1.0.0");
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Using cached latest version"),
      );
      expect(fs.writeFileSync).toHaveBeenCalled(); // manifest updated
    });

    it("throws error if latest release response is missing tag_name", async () => {
      (fs.existsSync as AnyMock).mockReturnValue(false);
      (global.fetch as unknown as AnyMock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      await expect(installCaretta("latest", "token")).rejects.toThrow(
        "Latest release response missing tag_name",
      );
    });
  });

  describe("installLinuxRuntimeDeps", () => {
    it("skips on non-linux", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      await installLinuxRuntimeDeps();
      expect(exec.exec).not.toHaveBeenCalled();
    });

    it("installs on linux", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      await installLinuxRuntimeDeps();
      expect(exec.exec).toHaveBeenCalledWith(
        "sudo",
        expect.arrayContaining(["apt-get", "update", "-qq"]),
        expect.anything(),
      );
    });
  });

  describe("configureGitIdentity", () => {
    it("does nothing when name or email is empty", async () => {
      await configureGitIdentity("", "bot@example.com");
      await configureGitIdentity("bot", "");
      expect(exec.exec).not.toHaveBeenCalled();
    });

    it("configures git user.name and user.email globally", async () => {
      await configureGitIdentity("bot-name", "bot@example.com");
      expect(exec.exec).toHaveBeenCalledWith("git", [
        "config",
        "--global",
        "user.name",
        "bot-name",
      ]);
      expect(exec.exec).toHaveBeenCalledWith("git", [
        "config",
        "--global",
        "user.email",
        "bot@example.com",
      ]);
    });
  });

  describe("mintInstallationToken", () => {
    const TEST_PEM_B64 = (() => {
      const { generateKeyPairSync } = require("node:crypto");
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
      return Buffer.from(pem).toString("base64");
    })();

    it("uses provided installation id and posts to access_tokens endpoint", async () => {
      (global.fetch as unknown as AnyMock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "ghs_abc123" }),
      });

      const token = await mintInstallationToken({
        appId: "42",
        privateKeyB64: TEST_PEM_B64,
        owner: "acme",
        repo: "widgets",
        installationId: "100",
      });

      expect(token).toBe("ghs_abc123");
      const calls = (global.fetch as unknown as AnyMock).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(
        "https://api.github.com/app/installations/100/access_tokens",
      );
      expect(calls[0][1].method).toBe("POST");
      expect(calls[0][1].headers.Authorization).toMatch(/^Bearer /);
    });

    it("looks up installation by repo when installation id is missing", async () => {
      (global.fetch as unknown as AnyMock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 555 }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "ghs_xyz" }),
        });

      const token = await mintInstallationToken({
        appId: "42",
        privateKeyB64: TEST_PEM_B64,
        owner: "acme",
        repo: "widgets",
      });

      expect(token).toBe("ghs_xyz");
      const calls = (global.fetch as unknown as AnyMock).mock.calls;
      expect(calls[0][0]).toBe(
        "https://api.github.com/repos/acme/widgets/installation",
      );
      expect(calls[1][0]).toBe(
        "https://api.github.com/app/installations/555/access_tokens",
      );
    });

    it("throws when installation lookup fails", async () => {
      (global.fetch as unknown as AnyMock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(
        mintInstallationToken({
          appId: "42",
          privateKeyB64: TEST_PEM_B64,
          owner: "acme",
          repo: "widgets",
        }),
      ).rejects.toThrow(/Failed to resolve GitHub App installation/);
    });

    it("throws when access_tokens response is missing token", async () => {
      (global.fetch as unknown as AnyMock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await expect(
        mintInstallationToken({
          appId: "42",
          privateKeyB64: TEST_PEM_B64,
          owner: "acme",
          repo: "widgets",
          installationId: "100",
        }),
      ).rejects.toThrow(/missing token/);
    });
  });

  describe("materializeBotPrivateKey", () => {
    it("does nothing if B64 is missing", () => {
      const env = {};
      materializeBotPrivateKey(env);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("decodes and writes PEM if B64 is present", () => {
      const key = "private-key-content";
      const b64 = Buffer.from(key).toString("base64");
      const env: Record<string, string> = {
        DEV_BOT_PRIVATE_KEY_B64: b64,
        RUNNER_TEMP: "/tmp",
      };

      materializeBotPrivateKey(env);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("dev-bot.pem"),
        key,
        expect.anything(),
      );
      expect(env.DEV_BOT_PRIVATE_KEY).toContain("dev-bot.pem");
    });
  });
});
