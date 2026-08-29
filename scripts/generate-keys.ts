/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Emit a fresh value for every platform cryptographic key.
 *
 * Enumerates `PLATFORM_KEYS` rather than listing names, so a key added to the
 * inventory is generated here without anyone remembering to update this file —
 * which is the failure mode that produced the problem this split exists to fix.
 *
 *   npx tsx scripts/generate-keys.ts            # all six, paste-ready
 *   npx tsx scripts/generate-keys.ts --missing  # only the ones not already set
 *   npx tsx scripts/generate-keys.ts --check    # exit 1 if any is missing/invalid
 */
import { randomBytes } from "node:crypto";
import {
  PLATFORM_KEYS,
  missingPlatformKeys,
  type PlatformKeyName,
} from "../src/lib/env/keys";
import { loadEnv } from "./load-env";

const KEY_BYTES = 32;
const names = Object.keys(PLATFORM_KEYS) as PlatformKeyName[];

function main() {
  const mode = process.argv[2];

  if (mode === "--check") {
    loadEnv();
    const missing = missingPlatformKeys();
    if (missing.length === 0) {
      console.log(`All ${names.length} platform keys are set and well-formed.`);
      return;
    }
    console.error(`${missing.length} platform key(s) missing or malformed:\n`);
    for (const m of missing) console.error(`  ${m.env}\n    ${m.reason}`);
    console.error(
      "\nGenerate the missing ones with:\n  npx tsx scripts/generate-keys.ts --missing",
    );
    process.exit(1);
  }

  const onlyMissing = mode === "--missing";
  if (onlyMissing) loadEnv();

  const wanted = onlyMissing
    ? names.filter((n) => {
        const v = process.env[PLATFORM_KEYS[n].env];
        return !v || v.length !== KEY_BYTES * 2;
      })
    : names;

  if (wanted.length === 0) {
    console.log("# Every platform key is already set.");
    return;
  }

  console.log(
    "# Platform cryptographic keys. Each protects exactly one thing, so rotating",
    "\n# one has a bounded blast radius. See src/lib/env/keys.ts.\n",
  );
  for (const n of wanted) {
    const spec = PLATFORM_KEYS[n];
    console.log(`# ${spec.purpose}`);
    console.log(`# Rotating: ${spec.rotationEffect}`);
    console.log(`${spec.env}=${randomBytes(KEY_BYTES).toString("hex")}\n`);
  }
}

main();
