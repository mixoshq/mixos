/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { fingerprintOf, newPrivateKeyPem } from "./fake-github";
import { appJwt, keyFingerprint, parsePrivateKey, PrivateKeyError, storedPem } from "./jwt";

const { pem } = newPrivateKeyPem();

test("a key reads as GitHub hands it out, PKCS#1, and as PKCS#8", () => {
  const key = parsePrivateKey(pem);
  assert.equal(key.asymmetricKeyType, "rsa");
  const pkcs8 = storedPem(key);
  assert.match(pkcs8, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(keyFingerprint(parsePrivateKey(pkcs8)), keyFingerprint(key));
  // Pasted with Windows line endings and blank lines round it.
  assert.equal(keyFingerprint(parsePrivateKey(`\r\n${pem.replace(/\n/g, "\r\n")}\r\n`)), keyFingerprint(key));
});

test("anything else is refused, saying what is wrong and never repeating the text", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const publicOnly = createPublicKey(parsePrivateKey(pem)).export({ type: "spki", format: "pem" }) as string;
  const garbled = `-----BEGIN RSA PRIVATE KEY-----\n${randomBytes(600)
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END RSA PRIVATE KEY-----`;
  for (const [input, says] of [
    ["", /Paste the private key/],
    ["ghs_notakey", /isn't a private key in PEM format/],
    [publicOnly, /isn't a private key in PEM format/],
    [ec, /isn't an RSA key/],
    [small, /1024 bits/],
    [garbled, /can't be read/],
    ["x".repeat(20_000), /too long/],
  ] as const) {
    assert.throws(
      () => parsePrivateKey(input),
      (err: unknown) => {
        const echoed = input.length > 60 && err instanceof Error && err.message.includes(input.slice(30, 60));
        return err instanceof PrivateKeyError && says.test(err.message) && !echoed;
      },
      String(says),
    );
  }
});

test("the fingerprint is GitHub's: SHA-256 over the public key's DER, base64", () => {
  const key = parsePrivateKey(pem);
  assert.equal(keyFingerprint(key), fingerprintOf(key));
  assert.match(keyFingerprint(key), /^SHA256:[A-Za-z0-9+/]{43}=$/);
});

test("a JWT is RS256, issued a minute back, nine minutes long, for the App's id", () => {
  const key = parsePrivateKey(pem);
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);
  const jwt = appJwt(4242, key, now);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual(claims, { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "4242" });
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey(key), Buffer.from(signature, "base64url")));
});
