/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MIXOS_ORG_KEYS,
  keyIdFor,
  parseKeys,
  signatureMessage,
  signatureProblem,
  trustedKeys,
  type SignedFields,
} from "./release-signature";
import { TEST_KEY_ID, TEST_REPOSITORY_KEYS, signedForTest } from "./test-signing";

/**
 * The cross-repository test vector. mixos.org's test, in the mixos-org
 * repository's packages/cli/test/release-signature.test.ts, signs the same
 * release with the same key and expects the same signature, so the two ends
 * can't drift apart on what is signed.
 */
const RELEASE: SignedFields = {
  kind: "app",
  slug: "files",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  contentHash: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  contentHashAlgorithm: "mixos-tree-v1",
  requiresMixOS: "0.4.0",
};
const MESSAGE = [
  "mixos-release-v1",
  "kind=app",
  "slug=files",
  "version=1.2.0",
  "tag=v1.2.0",
  "commit=0123456789abcdef0123456789abcdef01234567",
  "hash=sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  "algorithm=mixos-tree-v1",
  "requires-mixos=0.4.0",
].join("\n");
const SIGNATURE =
  "obWBXfi3RPr0sdk5BtCWsVFUXsMrzGao4/jJ2A4PyBp0p1A6vMcEVfFi9vGUVgMREWG/rlqtnZZC/y+f1EQdAQ==";

const DEV_KEYS = trustedKeys(true, { MIXOS_REPOSITORY_KEYS: TEST_REPOSITORY_KEYS });

describe("release signatures", () => {
  test("the signed text and the signature match mixos.org's test vector", () => {
    assert.equal(signatureMessage(RELEASE), MESSAGE);
    assert.deepEqual(signedForTest(RELEASE).signature, { keyId: TEST_KEY_ID, value: SIGNATURE });
  });

  test("a missing tag or floor is an empty value, not a missing line", () => {
    const text = signatureMessage({ ...RELEASE, gitTag: null, requiresMixOS: undefined });
    assert.match(text, /\ntag=\n/);
    assert.match(text, /\nrequires-mixos=$/);
  });

  test("a release signed by a trusted key passes", () => {
    assert.equal(signatureProblem(signedForTest(RELEASE), DEV_KEYS), null);
  });

  test("any signed field changed after signing fails", () => {
    const signed = signedForTest(RELEASE);
    const changes: Partial<SignedFields>[] = [
      { kind: "connector" },
      { slug: "filez" },
      { version: "1.2.1" },
      { gitTag: "v1.2.1" },
      { gitTag: null },
      { commitSha: "f".repeat(40) },
      { contentHash: "sha256-swapped" },
      { contentHashAlgorithm: "mixos-tree-v2" },
      { requiresMixOS: null },
    ];
    for (const change of changes) {
      assert.match(signatureProblem({ ...signed, ...change }, DEV_KEYS) ?? "", /doesn't match the release/, JSON.stringify(change));
    }
  });

  test("an unsigned release, or one signed by an unknown key, is refused", () => {
    const { signature, ...unsigned } = signedForTest(RELEASE);
    assert.match(signatureProblem(unsigned, DEV_KEYS) ?? "", /isn't signed/);
    assert.match(signatureProblem({ ...unsigned, signature: null }, DEV_KEYS) ?? "", /isn't signed/);
    assert.match(
      signatureProblem({ ...unsigned, signature: { ...signature, keyId: "0000000000000000" } }, DEV_KEYS) ?? "",
      /a key this instance doesn't trust \(0000000000000000\)/,
    );
  });

  test("a line break in a signed field is refused, not signed around", () => {
    const signed = signedForTest(RELEASE);
    assert.match(signatureProblem({ ...signed, version: "1.2.0\ncommit=x" }, DEV_KEYS) ?? "", /line break/);
  });

  test("development keys are never trusted for mixos.org's answers", () => {
    const env = { MIXOS_REPOSITORY_KEYS: TEST_REPOSITORY_KEYS };
    assert.ok(trustedKeys(true, env).has(TEST_KEY_ID));
    assert.ok(!trustedKeys(false, env).has(TEST_KEY_ID));
    assert.match(signatureProblem(signedForTest(RELEASE), trustedKeys(false, env)) ?? "", /doesn't trust/);
  });

  test("a key list that isn't one, or names the wrong key, is an error", () => {
    assert.throws(() => parseKeys("not-a-key"), /not a release signing key/);
    assert.throws(() => parseKeys(`0000000000000000:${TEST_REPOSITORY_KEYS.split(":")[1]}`), /isn't the key its id names/);
    assert.equal(parseKeys("").size, 0);
    assert.equal(parseKeys(` ${TEST_REPOSITORY_KEYS} ,`).size, 1);
  });

  test("every pinned mixos.org key is the key its id names", () => {
    for (const [id, key] of Object.entries(MIXOS_ORG_KEYS)) {
      assert.equal(keyIdFor(Buffer.from(key, "base64")), id);
    }
  });
});
