/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Emit a fresh value for every key a deployment needs: AUTH_SECRET,
 * CRON_SECRET and the six platform cryptographic keys.
 *
 * Enumerates `DEPLOYMENT_SECRETS` and `PLATFORM_KEYS` rather than listing
 * names, so a key added to either inventory is generated here without anyone
 * remembering to update this file — which is the failure mode that produced the
 * problem this split exists to fix.
 *
 *   npx tsx scripts/generate-keys.ts            # all eight, paste-ready
 *   npx tsx scripts/generate-keys.ts --missing  # only the ones not already set
 *   npx tsx scripts/generate-keys.ts --check    # exit 1 if any is missing/invalid
 */
import { randomBytes } from "node:crypto";
import {
  DEPLOYMENT_SECRETS,
  PLATFORM_KEYS,
  missingDeploymentSecrets,
  missingPlatformKeys,
  platformKey,
  type DeploymentSecretName,
  type PlatformKeyName,
  type PlatformKeySpec,
} from "../src/lib/env/keys";
import { loadEnv } from "./load-env";

const KEY_BYTES = 32;
const secretNames = Object.keys(DEPLOYMENT_SECRETS) as DeploymentSecretName[];
const keyNames = Object.keys(PLATFORM_KEYS) as PlatformKeyName[];
const total = secretNames.length + keyNames.length;

function main() {
  const mode = process.argv[2];

  if (mode === "--check") {
    loadEnv();
    const missing = [...missingDeploymentSecrets(), ...missingPlatformKeys()];
    if (missing.length === 0) {
      console.log(`All ${total} keys are set and well-formed.`);
      return;
    }
    console.error(`${missing.length} key(s) missing or malformed:\n`);
    for (const m of missing) console.error(`  ${m.env}\n    ${m.reason}`);
    console.error(
      "\nGenerate the missing ones with:\n  npx tsx scripts/generate-keys.ts --missing",
    );
    process.exit(1);
  }

  const onlyMissing = mode === "--missing";
  if (onlyMissing) loadEnv();

  const wanted: PlatformKeySpec[] = [
    ...secretNames
      .map((n) => DEPLOYMENT_SECRETS[n])
      .filter((spec) => !onlyMissing || !process.env[spec.env]),
    ...keyNames
      .filter((n) => {
        if (!onlyMissing) return true;
        // The same validation the app applies, so a base64 key a hosting
        // platform generated counts as present.
        try {
          platformKey(n);
          return false;
        } catch {
          return true;
        }
      })
      .map((n) => PLATFORM_KEYS[n]),
  ];

  if (wanted.length === 0) {
    console.log("# Every key is already set.");
    return;
  }

  console.log(
    "# Keys for a MixOS deployment. Each protects exactly one thing, so rotating\n" +
      "# one has a bounded blast radius. See src/lib/env/keys.ts.\n",
  );
  for (const spec of wanted) {
    console.log(`# ${spec.purpose}`);
    console.log(`# Rotating: ${spec.rotationEffect}`);
    console.log(`${spec.env}=${randomBytes(KEY_BYTES).toString("hex")}\n`);
  }
}

main();
