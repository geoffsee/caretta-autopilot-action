import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { makeAppJwt } from "../src/app-token.js";

describe("makeAppJwt", () => {
  test("produces an RS256-signed JWT with iss=appId and a <=10 min expiry", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const now = Math.floor(Date.now() / 1000);
    const jwt = makeAppJwt({ appId: "12345", privateKey });

    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBeGreaterThanOrEqual(now - 120);
    expect(payload.iat).toBeLessThanOrEqual(now + 5);
    expect(payload.exp - payload.iat).toBeGreaterThan(0);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);

    const verify = createVerify("RSA-SHA256");
    verify.update(`${headerB64}.${payloadB64}`);
    expect(verify.verify(publicKey, Buffer.from(sigB64, "base64url"))).toBe(
      true,
    );
  });
});
