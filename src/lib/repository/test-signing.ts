/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Signing for tests: a fixed Ed25519 key, and the manifests a test catalogue
 * serves with it. Imported by tests alone.
 *
 * TEST KEY ONLY. Its private half is 32 bytes of 0x01, so it signs nothing
 * anyone should trust. This instance trusts it only through
 * MIXOS_REPOSITORY_KEYS, which never applies to mixos.org's answers, and every
 * test catalogue is on 127.0.0.1.
 */

import { createPrivateKey, sign } from "node:crypto";
import { signatureMessage, type SignedFields } from "./release-signature";

const TEST_KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 1)]),
  format: "der",
  type: "pkcs8",
});

/** The test key's id. */
export const TEST_KEY_ID = "34750f98bd59fcfc";

/** MIXOS_REPOSITORY_KEYS for a test catalogue that signs with the test key. */
export const TEST_REPOSITORY_KEYS = `${TEST_KEY_ID}:iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=`;

type Unsigned = Omit<SignedFields, "contentHashAlgorithm"> & { contentHashAlgorithm?: string };

/**
 * A manifest as a test catalogue serves it: with `contentHashAlgorithm` when
 * the fixture leaves it out, and the test key's signature over it.
 */
export function signedForTest<T extends Unsigned>(
  manifest: T,
): T & { contentHashAlgorithm: string; signature: { keyId: string; value: string } } {
  const complete = { ...manifest, contentHashAlgorithm: manifest.contentHashAlgorithm ?? "mixos-tree-v1" };
  const value = sign(null, Buffer.from(signatureMessage(complete), "utf8"), TEST_KEY).toString("base64");
  return { ...complete, signature: { keyId: TEST_KEY_ID, value } };
}
