import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppCreds } from "./execute.js";

interface JwtInput {
  readonly appId: string;
  readonly privateKey: string;
}

export function makeAppJwt(input: JwtInput): string {
  const pem = input.privateKey.includes("-----BEGIN")
    ? input.privateKey
    : readFileSync(input.privateKey, "utf8");
  const iat = Math.floor(Date.now() / 1000) - 60;
  const exp = iat + 600;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp, iss: input.appId }));
  const sig = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(pem);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

export async function defaultMintAppToken(creds: AppCreds): Promise<string> {
  const jwt = makeAppJwt(creds);
  const url = `https://api.github.com/app/installations/${creds.installationId}/access_tokens`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "caretta-autopilot-action",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to mint App installation token (HTTP ${res.status}): ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("App token response missing token field");
  return body.token;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
