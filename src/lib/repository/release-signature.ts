/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Release signatures: what this instance checks before it trusts an answer
 * about a release.
 *
 * mixos.org signs each release when it is published, with a key its database
 * never holds, and the public halves this instance trusts are pinned below.
 * `fetchInstallManifest` (./client.ts) checks every install manifest against
 * them as it arrives, before anything else reads it, so no install, update,
 * proposal or preview acts on a release mixos.org didn't sign, or one that
 * changed after it did. The content hash ties the files to the commit; the
 * signature ties both to mixos.org.
 *
 * WHAT IS SIGNED
 * --------------
 * One canonical text, a line per field in a fixed order, built the same way as
 * mixos.org builds it, in src/lib/registry/release-signature.ts in the
 * mixos-org repository. Both repositories test the same release, key and
 * signature (./release-signature.test.ts), so they can't drift apart
 * unnoticed. Not the repository the code comes from: that belongs to the
 * listing and moves with it, and the content hash pins the files wherever they
 * are fetched from.
 *
 * A DEVELOPMENT CATALOGUE
 * -----------------------
 * A checkout pointed at a catalogue other than mixos.org, such as a copy of
 * the site on this machine, trusts that catalogue's own keys from
 * MIXOS_REPOSITORY_KEYS. They are never trusted for mixos.org's answers.
 */

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/** The first line of the signed text: the format's name and version. */
export const SIGNATURE_FORMAT = "mixos-release-v1";

/**
 * mixos.org's release signing keys, by id: the first 8 bytes of the SHA-256 of
 * the raw Ed25519 public key, as hex, to the raw key, as base64.
 *
 * A new key is added here, in a release of MixOS, before mixos.org signs with
 * it, and an old one stays while releases signed with it should still install.
 * See "The release signing key" in the mixos-org repository's SETUP.md.
 */
export const MIXOS_ORG_KEYS: Readonly<Record<string, string>> = {
  // mixos.org's first key, made 2026-10-25.
  ec3e14a551b27743: "Lh+GCWAPNA3cl0YHiiZx+EncH1H2CIuGWKRz/DeuIN8=",
};

/** The fields a signature covers, as an install manifest carries them. */
export interface SignedFields {
  kind: string;
  slug: string;
  version: string;
  gitTag?: string | null;
  commitSha: string;
  contentHash: string;
  contentHashAlgorithm: string;
  requiresMixOS?: string | null;
}

/** The exact text a signature covers. A missing tag or floor is empty. */
export function signatureMessage(r: SignedFields): string {
  const lines = [
    SIGNATURE_FORMAT,
    `kind=${r.kind}`,
    `slug=${r.slug}`,
    `version=${r.version}`,
    `tag=${r.gitTag ?? ""}`,
    `commit=${r.commitSha}`,
    `hash=${r.contentHash}`,
    `algorithm=${r.contentHashAlgorithm}`,
    `requires-mixos=${r.requiresMixOS ?? ""}`,
  ];
  // A line break in a field would let it pass for the next one.
  for (const line of lines) {
    if (/[\r\n]/.test(line)) throw new Error("A signed release field cannot contain a line break.");
  }
  return lines.join("\n");
}

/** A public key's id: the first 8 bytes of its SHA-256, as hex. */
export function keyIdFor(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest().subarray(0, 8).toString("hex");
}

/**
 * Keys written as `<key id>:<raw public key, base64>`, comma-separated, as
 * MIXOS_REPOSITORY_KEYS and the pinned list are. Throws on anything else,
 * including an id that isn't its key's: a typo here should stop an install,
 * not quietly trust nothing, or the wrong thing.
 */
export function parseKeys(value: string): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const entry of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const match = /^([0-9a-f]{16}):([A-Za-z0-9+/]{43}=)$/.exec(entry);
    if (!match) {
      throw new Error(`"${entry}" is not a release signing key: write it as <key id>:<base64 public key>.`);
    }
    const [, id, encoded] = match;
    const raw = Buffer.from(encoded, "base64");
    if (raw.length !== 32 || keyIdFor(raw) !== id) {
      throw new Error(`The release signing key ${id} isn't the key its id names.`);
    }
    keys.set(id, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" }));
  }
  return keys;
}

const PINNED = parseKeys(
  Object.entries(MIXOS_ORG_KEYS)
    .map(([id, key]) => `${id}:${key}`)
    .join(","),
);

/**
 * The keys this instance trusts for a catalogue's answers: mixos.org's, and,
 * for a development catalogue, MIXOS_REPOSITORY_KEYS as well.
 */
export function trustedKeys(
  developmentCatalogue: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Map<string, KeyObject> {
  if (!developmentCatalogue || !env.MIXOS_REPOSITORY_KEYS) return PINNED;
  return new Map([...PINNED, ...parseKeys(env.MIXOS_REPOSITORY_KEYS)]);
}

/**
 * Why a manifest's signature isn't one to trust, or null when it is. The
 * reason reads as the end of "nothing was downloaded, because …".
 */
export function signatureProblem(
  manifest: SignedFields & { signature?: { keyId: string; value: string } | null },
  keys: Map<string, KeyObject>,
): string | null {
  const release = `${manifest.kind}/${manifest.slug} ${manifest.version}`;
  const { signature } = manifest;
  if (!signature) {
    return `The repository's answer for ${release} isn't signed, so nothing was downloaded. Only signed releases install.`;
  }
  const key = keys.get(signature.keyId);
  if (!key) {
    return (
      `The repository's answer for ${release} is signed with a key this instance doesn't trust ` +
      `(${signature.keyId}), so nothing was downloaded. If mixos.org has started signing with a ` +
      `new key, upgrading MixOS brings it in.`
    );
  }
  let text: string;
  try {
    text = signatureMessage(manifest);
  } catch {
    return `The repository's answer for ${release} has a line break in a signed field, so nothing was downloaded.`;
  }
  if (!verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signature.value, "base64"))) {
    return (
      `The signature on the repository's answer for ${release} doesn't match the release, so ` +
      `nothing was downloaded. The release, or the answer about it, changed after it was signed.`
    );
  }
  return null;
}
