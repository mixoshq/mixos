/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The App's private key, and the JWTs it signs.
 *
 * A JWT is how the App speaks as itself to GitHub: to read and remove its own
 * installation and to mint installation tokens (./installation.ts). It is
 * signed RS256 with `node:crypto`, made for one operation, and lives at most
 * ten minutes, GitHub's own limit. Like the tokens, it is never stored, logged
 * or sent to a browser.
 */

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

/** A pasted key larger than this isn't one GitHub generated. */
const MAX_PEM_CHARS = 16_384;

/** GitHub generates 2048-bit RSA keys. */
const MIN_MODULUS_BITS = 2048;

/** Issued a minute back, so a clock a little ahead of GitHub's isn't refused. */
const ISSUED_BEFORE_SECONDS = 60;
/** GitHub refuses a JWT that expires more than ten minutes out. */
const LIFETIME_SECONDS = 9 * 60;

export class PrivateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateKeyError";
  }
}

/**
 * Read a private key as GitHub hands it out: PEM, RSA, at least 2048 bits.
 * Throws PrivateKeyError saying what is wrong, never repeating the text.
 */
export function parsePrivateKey(pem: string): KeyObject {
  const text = typeof pem === "string" ? pem.trim() : "";
  if (!text) throw new PrivateKeyError("Paste the private key, the whole .pem file.");
  if (text.length > MAX_PEM_CHARS) throw new PrivateKeyError("That is too long to be a private key from GitHub.");
  if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----$/.test(text)) {
    throw new PrivateKeyError(
      "That isn't a private key in PEM format. It starts with -----BEGIN RSA PRIVATE KEY-----.",
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: "pem" });
  } catch {
    throw new PrivateKeyError("That private key can't be read. Paste the whole .pem file GitHub downloaded.");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new PrivateKeyError("That isn't an RSA key. GitHub Apps use RSA keys.");
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_MODULUS_BITS) {
    throw new PrivateKeyError(`That key is ${bits} bits. GitHub Apps use keys of ${MIN_MODULUS_BITS} bits or more.`);
  }
  return key;
}

/** The key as it is stored, encrypted: PKCS#8 PEM, whatever form it was pasted in. */
export function storedPem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/**
 * The fingerprint GitHub shows beside each of an App's keys: SHA-256 over the
 * public key's DER, base64. Public, so it can be shown and audited, and it says
 * which key on GitHub's list is the one this instance holds.
 */
export function keyFingerprint(key: KeyObject): string {
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * A JWT for App `appId`: RS256, issued a minute ago, expiring in nine minutes.
 * One per operation.
 */
export function appJwt(appId: number, key: KeyObject, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: seconds - ISSUED_BEFORE_SECONDS, exp: seconds + LIFETIME_SECONDS, iss: String(appId) }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}
