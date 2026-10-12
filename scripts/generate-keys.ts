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
 * The optional keys (`OPTIONAL_PLATFORM_KEYS`) each turn a feature on, so they
 * are printed only when asked for, and `--check` validates one only when it is
 * set.
 *
 *   npx tsx scripts/generate-keys.ts               # all eight, paste-ready
 *   npx tsx scripts/generate-keys.ts --missing     # only the ones not already set
 *   npx tsx scripts/generate-keys.ts --check       # exit 1 if any is missing/invalid
 *   npx tsx scripts/generate-keys.ts --github-app  # GITHUB_APP_ENCRYPTION_KEY only
 */
import { randomBytes } from "node:crypto";
import {
  DEPLOYMENT_SECRETS,
  OPTIONAL_PLATFORM_KEYS,
  PLATFORM_KEYS,
  malformedOptionalKeys,
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

function print(specs: PlatformKeySpec[]): void {
  for (const spec of specs) {
    console.log(`# ${spec.purpose}`);
    console.log(`# Rotating: ${spec.rotationEffect}`);
    console.log(`${spec.env}=${randomBytes(KEY_BYTES).toString("hex")}\n`);
  }
}

function main() {
  const mode = process.argv[2];

  if (mode === "--check") {
    loadEnv();
    const missing = [...missingDeploymentSecrets(), ...missingPlatformKeys(), ...malformedOptionalKeys()];
    if (missing.length === 0) {
      console.log(`All ${total} keys are set and well-formed.`);
      for (const spec of Object.values(OPTIONAL_PLATFORM_KEYS)) {
        console.log(
          process.env[spec.env]
            ? `${spec.env} is set and well-formed.`
            : `${spec.env} is not set, so what it turns on is off.`,
        );
      }
      return;
    }
    console.error(`${missing.length} key(s) missing or malformed:\n`);
    for (const m of missing) console.error(`  ${m.env}\n    ${m.reason}`);
    console.error(
      "\nGenerate the missing ones with:\n  npx tsx scripts/generate-keys.ts --missing",
    );
    process.exit(1);
  }

  if (mode === "--github-app") {
    console.log(
      "# Turns on the GitHub App (Admin > GitHub). Set it where the app runs,\n" +
        "# and keep a copy: the App's private key is stored encrypted under it.\n",
    );
    print([OPTIONAL_PLATFORM_KEYS.githubAppEncryption]);
    return;
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
  print(wanted);
  console.log(
    "# Not printed: GITHUB_APP_ENCRYPTION_KEY, which turns on the GitHub App.\n" +
      "# npm run keys:generate -- --github-app prints one.",
  );
}

main();
