import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";

const REPO = "geoffsee/caretta";
const BINARY = "caretta";

type Platform = {
  os: "linux" | "macos";
  arch: "x86_64" | "aarch64";
};

type VersionManifest = {
  resolvedVersion: string;
  cachedAt: string;
  platform: string;
};

function detectPlatform(): Platform {
  const rawOs = process.platform;
  const rawArch = process.arch;

  let osName: Platform["os"];
  if (rawOs === "linux") osName = "linux";
  else if (rawOs === "darwin") osName = "macos";
  else
    throw new Error(
      `Unsupported OS: ${rawOs} (caretta supports linux and macOS runners)`,
    );

  let archName: Platform["arch"];
  if (rawArch === "x64") archName = "x86_64";
  else if (rawArch === "arm64") archName = "aarch64";
  else throw new Error(`Unsupported architecture: ${rawArch}`);

  return { os: osName, arch: archName };
}

async function resolveVersion(token: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "caretta-autopilot-action",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { headers },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to resolve latest caretta release: ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { tag_name?: string };
  if (!body.tag_name)
    throw new Error("Latest release response missing tag_name");
  return body.tag_name;
}

function getManifestPath(platform: Platform): string {
  const tempDir = process.env.RUNNER_TEMP || os.tmpdir();
  return path.join(
    tempDir,
    `caretta-manifest-${platform.arch}-${platform.os}.json`,
  );
}

async function loadVersionManifest(
  platform: Platform,
): Promise<VersionManifest | null> {
  const manifestPath = getManifestPath(platform);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(content) as VersionManifest;
  } catch {
    return null;
  }
}

async function saveVersionManifest(
  manifest: VersionManifest,
  platform: Platform,
): Promise<void> {
  const manifestPath = getManifestPath(platform);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

async function checkNewReleaseAvailable(
  currentVersion: string,
  token: string,
): Promise<string | null> {
  try {
    const latestVersion = await resolveVersion(token);
    if (latestVersion !== currentVersion) {
      core.info(
        `New release available: ${latestVersion} (current: ${currentVersion})`,
      );
      return latestVersion;
    }
    return null;
  } catch (err) {
    core.warning(`Failed to check for new releases: ${err}`);
    return null;
  }
}

export async function installCaretta(
  versionInput: string,
  token: string,
): Promise<{ binaryPath: string; version: string }> {
  const platform = detectPlatform();
  const isLatestRequested = !versionInput || versionInput === "latest";

  const manifest = await loadVersionManifest(platform);
  let version: string;

  if (isLatestRequested && manifest) {
    const newVersion = await checkNewReleaseAvailable(
      manifest.resolvedVersion,
      token,
    );
    if (newVersion) {
      version = newVersion;
      core.info(`Upgrading from ${manifest.resolvedVersion} to ${version}`);
    } else {
      version = manifest.resolvedVersion;
      core.info(`Using cached latest version: ${version}`);
    }
  } else if (!isLatestRequested) {
    version = versionInput.startsWith("v")
      ? versionInput
      : `v${versionInput.replace(/^v/, "")}`;
  } else {
    version = await resolveVersion(token);
  }

  const cached = tc.find(BINARY, version, platform.arch);
  if (cached) {
    core.info(`Using cached caretta ${version} from tool-cache`);
    const binaryPath = path.join(cached, BINARY);

    if (isLatestRequested) {
      await saveVersionManifest(
        {
          resolvedVersion: version,
          cachedAt: new Date().toISOString(),
          platform: `${platform.arch}-${platform.os}`,
        },
        platform,
      );
    }

    return { binaryPath, version };
  }

  const artifact = `${BINARY}-${platform.arch}-${platform.os}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/${version}/${artifact}`;
  core.info(`Downloading ${url}`);

  const tarball = await tc.downloadTool(url);
  const extracted = await tc.extractTar(tarball);
  const cachedDir = await tc.cacheDir(
    extracted,
    BINARY,
    version,
    platform.arch,
  );
  const binaryPath = path.join(cachedDir, BINARY);

  await exec.exec("chmod", ["+x", binaryPath]);
  core.addPath(cachedDir);

  if (isLatestRequested) {
    await saveVersionManifest(
      {
        resolvedVersion: version,
        cachedAt: new Date().toISOString(),
        platform: `${platform.arch}-${platform.os}`,
      },
      platform,
    );
  }

  return { binaryPath, version };
}

const LINUX_RUNTIME_DEPS = [
  "libxdo3",
  "libwebkit2gtk-4.1-0",
  "libgtk-3-0",
  "libayatana-appindicator3-1",
  "libsoup-3.0-0",
];

export async function installLinuxRuntimeDeps(): Promise<void> {
  if (process.platform !== "linux") return;
  core.info(
    `Installing caretta runtime deps: ${LINUX_RUNTIME_DEPS.join(", ")}`,
  );
  await exec.exec("sudo", ["apt-get", "update", "-qq"], { silent: true });
  await exec.exec(
    "sudo",
    [
      "apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      ...LINUX_RUNTIME_DEPS,
    ],
    { silent: true },
  );
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signAppJwt(appId: string, pem: string): string {
  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const data = `${header}.${payload}`;
  const sig = crypto.createSign("RSA-SHA256").update(data).sign(pem);
  return `${data}.${base64urlEncode(sig)}`;
}

export interface MintInstallationTokenOptions {
  appId: string;
  privateKeyB64: string;
  owner: string;
  repo: string;
  /** When provided, skips installation lookup. */
  installationId?: string;
}

/**
 * Exchange a GitHub App's private key + app id for a short-lived installation
 * access token (used as `GH_TOKEN` so caretta can create PRs).
 */
export async function mintInstallationToken(
  opts: MintInstallationTokenOptions,
): Promise<string> {
  const pem = Buffer.from(opts.privateKeyB64, "base64").toString("utf8");
  const jwt = signAppJwt(opts.appId, pem);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "caretta-autopilot-action",
  };

  let installationId = opts.installationId;
  if (!installationId) {
    const lookup = await fetch(
      `https://api.github.com/repos/${opts.owner}/${opts.repo}/installation`,
      { headers },
    );
    if (!lookup.ok) {
      throw new Error(
        `Failed to resolve GitHub App installation for ${opts.owner}/${opts.repo}: ${lookup.status} ${lookup.statusText}`,
      );
    }
    const body = (await lookup.json()) as { id?: number };
    if (!body.id) {
      throw new Error("Installation lookup returned no id");
    }
    installationId = String(body.id);
  }

  const tokRes = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers },
  );
  if (!tokRes.ok) {
    throw new Error(
      `Failed to mint installation token: ${tokRes.status} ${tokRes.statusText}`,
    );
  }
  const tokBody = (await tokRes.json()) as { token?: string };
  if (!tokBody.token) {
    throw new Error("Installation token response missing token");
  }
  core.setSecret(tokBody.token);
  return tokBody.token;
}

export async function configureGitIdentity(
  name: string,
  email: string,
): Promise<void> {
  if (!name || !email) return;
  core.info(`Configuring git identity: ${name} <${email}>`);
  await exec.exec("git", ["config", "--global", "user.name", name]);
  await exec.exec("git", ["config", "--global", "user.email", email]);
}

export function materializeBotPrivateKey(env: Record<string, string>): void {
  const b64 = env.DEV_BOT_PRIVATE_KEY_B64;
  if (!b64 || env.DEV_BOT_PRIVATE_KEY) return;
  const pem = Buffer.from(b64, "base64").toString("utf8");
  core.setSecret(pem);
  const dir =
    env.RUNNER_TEMP && env.RUNNER_TEMP.length > 0
      ? env.RUNNER_TEMP
      : os.tmpdir();
  const pemPath = path.join(dir, "dev-bot.pem");
  fs.writeFileSync(pemPath, pem, { mode: 0o600 });
  env.DEV_BOT_PRIVATE_KEY = pemPath;
  core.info(`Decoded DEV_BOT_PRIVATE_KEY_B64 to ${pemPath}`);
}
