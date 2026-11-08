/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One instance, one folder: the claims that record who owns an instance, the
 * name and port block a second checkout is given, the .env.instance it is
 * written to, and instance.ts reading that file back in the same run.
 * MIXOS_STATE_DIR points the claims at a scratch directory, never ~/.mixos.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-claims-"));
process.env.MIXOS_STATE_DIR = path.join(scratch, "state");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

import {
  chooseBase,
  chooseName,
  claimsFile,
  ownedElsewhere,
  ownerOf,
  readClaims,
  recordClaim,
  slugFor,
  writeInstanceFile,
} from "./instance-claims";
import { resolveInstance } from "./instance";

const REPO = path.resolve(__dirname, "..");

/** A fresh, unique instance name, so Docker on this machine has no evidence about it. */
let names = 0;
const fresh = () => `claims-test-${process.pid}-${names++}`;

/** A directory that looks like a MixOS checkout to isMixosCheckout(). */
function checkout(name: string): string {
  const root = path.join(scratch, name);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "instance.ts"), "");
  fs.writeFileSync(path.join(root, "docker-compose.yml"), "");
  return root;
}

test("a folder's name becomes an instance name compose accepts, reading as MixOS's", () => {
  assert.equal(slugFor("/Users/me/git/mixos-local-dev"), "mixos-local-dev");
  assert.equal(slugFor("/Users/me/MixOS"), "mixos");
  assert.equal(slugFor("/Users/me/Acme CRM!"), "mixos-acme-crm");
  assert.equal(slugFor("/Users/me/___"), "mixos-copy");
});

test("a taken name gets the first free number after it", () => {
  assert.equal(chooseName("/x/mixos-feature", new Set(["mixos"])), "mixos-feature");
  assert.equal(chooseName("/x/MixOS", new Set(["mixos", "mixos-2"])), "mixos-3");
});

test("the port block skips the default, held blocks, and blocks with a listener in them", () => {
  assert.equal(chooseBase(new Set([54320]), new Set()), 54340);
  assert.equal(chooseBase(new Set([54320, 54340]), new Set()), 54360);
  // 54362 is the database port of the 54360 block.
  assert.equal(chooseBase(new Set([54320, 54340]), new Set([54362])), 54380);
});

test("booting is claiming, and the claim names this folder as the owner", () => {
  const root = checkout("owner");
  const name = fresh();
  recordClaim({ ...resolveInstance(root), name }, root);
  assert.ok(fs.existsSync(claimsFile()));
  assert.equal(ownerOf(name), fs.realpathSync(root));
  assert.equal(ownedElsewhere(name, root), null, "a folder's own instance is not someone else's");
  assert.equal(ownedElsewhere(name, checkout("another")), fs.realpathSync(root));
});

test("a claim whose folder is gone no longer counts", () => {
  const root = checkout("short-lived");
  const name = fresh();
  recordClaim({ ...resolveInstance(root), name }, root);
  fs.rmSync(root, { recursive: true, force: true });
  assert.ok(readClaims()[name], "the claim is still on file");
  assert.equal(ownerOf(name), null);
});

test("a checkout given its own instance reads it back in the same run, as the file's", () => {
  const root = checkout("given");
  fs.writeFileSync(path.join(root, ".env.instance"), "MIXOS_PORT=3005\n");
  const before = resolveInstance(root);
  assert.equal(before.name, "mixos");
  assert.equal(before.nameSource, "default");

  writeInstanceFile(
    root,
    { name: "mixos-given", portBase: 54360, inspectorPort: 8085 },
    { owner: REPO, instance: "mixos" },
  );
  const after = resolveInstance(root);
  assert.equal(after.name, "mixos-given");
  assert.equal(after.nameSource, "file");
  assert.equal(after.ports.supabaseDb, 54362);
  assert.equal(after.ports.app, 3005, "what the file already said is kept");
  assert.equal(process.env.MIXOS_INSTANCE, "mixos-given", "and written back for the children");

  const text = fs.readFileSync(path.join(root, ".env.instance"), "utf8");
  assert.match(text, /^MIXOS_PORT=3005$/m);
  assert.match(text, /already uses the instance\n# `mixos`/);
});

test("a child resolving again tells the parent's written-back name from the person's own", () => {
  const root = checkout("child");
  // A file of its own, like the script a parent would start, so it loads the
  // way scripts/ do.
  const probe = path.join(scratch, "probe.ts");
  fs.writeFileSync(
    probe,
    `import { resolveInstance } from ${JSON.stringify(path.join(__dirname, "instance"))};\n` +
      `const i = resolveInstance(${JSON.stringify(root)});\nconsole.log(i.name + " " + i.nameSource);\n`,
  );
  const resolveIn = (env: Record<string, string>) => {
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(clean)) if (key.startsWith("MIXOS_")) delete clean[key];
    const r = spawnSync(process.execPath, ["--import", "tsx", probe], {
      encoding: "utf8",
      env: { ...clean, ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  // `npm run dev` resolved `mixos` by default and wrote it back; none of it was the shell's.
  assert.equal(resolveIn({ MIXOS_INSTANCE: "mixos", MIXOS_SHELL_KEYS: "" }), "mixos default");
  // The person typed MIXOS_INSTANCE=mixos-x, and that travels as the shell's.
  assert.equal(resolveIn({ MIXOS_INSTANCE: "mixos-x", MIXOS_SHELL_KEYS: "MIXOS_INSTANCE" }), "mixos-x shell");
  // No parent at all: whatever MIXOS_* is set came from the shell.
  assert.equal(resolveIn({ MIXOS_INSTANCE: "mixos-y" }), "mixos-y shell");
});
