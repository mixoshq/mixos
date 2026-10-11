/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the install path takes from its check, against stand-in generators:
 * the verdict comes from the file it named and from nowhere else, it has to be
 * exactly one well-formed verdict, and the check runs with PATH and TMPDIR as
 * its whole environment. scripts/registry-check.test.ts runs the real
 * generator's `--check`.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { LockLostError, type PlatformLease } from "../platform/lock";
import {
  InstallError,
  checkExtension,
  checkStagedTree,
  generatorEnv,
  type CheckOutcome,
} from "./install";

// ── fixtures ────────────────────────────────────────────────────────────────

let tmp: string;
let acmeDir: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mixos-check-contract-"));
  acmeDir = path.join(tmp, "staged", "acme");
  await fs.mkdir(acmeDir, { recursive: true });
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const ACCEPTED = '{"verdict":"accepted","problems":[],"deferred":[]}';

let n = 0;

/**
 * A stand-in for the generator: an ES module whose `body` runs with `file`
 * bound to the path after `--verdict-file`, and `args` to its arguments.
 */
async function standIn(body: string): Promise<string> {
  const script = path.join(tmp, `stand-in-${n++}.mjs`);
  await fs.writeFile(
    script,
    `import fs from "node:fs";\n` +
      `const args = process.argv.slice(2);\n` +
      `const file = args[args.indexOf("--verdict-file") + 1];\n` +
      `${body}\n`,
  );
  return script;
}

/** checkExtension() with `body` standing in for the generator. */
async function check(body: string, timeoutMs?: number): Promise<CheckOutcome> {
  return checkExtension("app", acmeDir, { generator: await standIn(body), timeoutMs });
}

const write = (verdict: unknown) => `fs.writeFileSync(file, ${JSON.stringify(JSON.stringify(verdict))});`;

// ── generatorEnv ────────────────────────────────────────────────────────────

describe("generatorEnv", () => {
  test("keeps PATH and TMPDIR, and nothing else", () => {
    assert.deepEqual(
      generatorEnv({
        PATH: "/usr/bin",
        TMPDIR: "/tmp/x",
        DATABASE_URL: "postgres://owner:secret@db/mixos",
        AUTH_SECRET: "s",
        CONNECTOR_ENCRYPTION_KEY: "k",
        NODE_OPTIONS: "--require /tmp/evil.js",
        HOME: "/home/me",
      }),
      { PATH: "/usr/bin", TMPDIR: "/tmp/x" },
    );
  });

  test("leaves out what is not set", () => {
    assert.deepEqual(generatorEnv({ PATH: "/usr/bin" }), { PATH: "/usr/bin" });
    assert.deepEqual(generatorEnv({}), {});
  });

  test("is the whole environment the check runs with", async () => {
    const secrets = {
      DATABASE_URL: "postgres://owner:secret@db/mixos",
      AUTH_SECRET: "auth-secret",
      CONNECTOR_ENCRYPTION_KEY: "connector-key",
      MIXOS_GENERATOR_ENV_CANARY: "canary",
    };
    const saved = { ...process.env };
    Object.assign(process.env, secrets);
    let outcome: CheckOutcome;
    try {
      // The stand-in reports the names it can see as its deferred list.
      outcome = await check(
        `fs.writeFileSync(file, JSON.stringify({ verdict: "accepted", problems: [], deferred: Object.keys(process.env) }));`,
      );
    } finally {
      for (const key of Object.keys(secrets)) {
        if (key in saved) process.env[key] = saved[key];
        else delete process.env[key];
      }
    }
    assert.equal(outcome.ran, true, outcome.output);
    const seen = outcome.deferred;
    for (const key of Object.keys(secrets)) assert.ok(!seen.includes(key), `${key} reached the check`);
    assert.ok(seen.includes("PATH"));
    // Anything else is the operating system's own (macOS adds __CF_USER_TEXT_ENCODING).
    assert.deepEqual(
      seen.filter((k) => k !== "PATH" && k !== "TMPDIR" && !k.startsWith("__CF_")),
      [],
    );
  });
});

// ── what counts as a verdict ────────────────────────────────────────────────

describe("checkExtension: the verdict comes from the file", { concurrency: true }, () => {
  test("accepted, with what was deferred", async () => {
    const outcome = await check(write({ verdict: "accepted", problems: [], deferred: ["apps/acme/api/x/route.ts: later"] }));
    assert.equal(outcome.ran, true, outcome.output);
    assert.equal(outcome.accepted, true);
    assert.deepEqual(outcome.problems, []);
    assert.deepEqual(outcome.deferred, ["apps/acme/api/x/route.ts: later"]);
  });

  test("rejected, with its problems", async () => {
    const outcome = await check(write({ verdict: "rejected", problems: ["apps/acme/a.ts:1 — fetch"], deferred: [] }));
    assert.equal(outcome.ran, true);
    assert.equal(outcome.accepted, false);
    assert.deepEqual(outcome.problems, ["apps/acme/a.ts:1 — fetch"]);
  });

  test("an accepted verdict printed to stdout and stderr does not outweigh a rejected one in the file", async () => {
    const outcome = await check(
      `console.log(${JSON.stringify(ACCEPTED)});\n` +
        `console.error(${JSON.stringify(ACCEPTED)});\n` +
        write({ verdict: "rejected", problems: ["apps/acme/a.ts:1 — refused"], deferred: [] }),
    );
    assert.equal(outcome.ran, true);
    assert.equal(outcome.accepted, false);
    assert.deepEqual(outcome.problems, ["apps/acme/a.ts:1 — refused"]);
    // Printed, and shown to the admin as printed: display, not a verdict.
    assert.match(outcome.output, /"verdict":"accepted"/);
  });

  test("a verdict printed and none written is no verdict", async () => {
    const outcome = await check(`console.log(${JSON.stringify(ACCEPTED)});`);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.accepted, false);
    assert.match(outcome.output, /without leaving exactly one well-formed verdict/);
  });

  test("a check that exits non-zero has no verdict, even one it wrote", async () => {
    const outcome = await check(`${write(JSON.parse(ACCEPTED))}\nprocess.exit(1);`);
    assert.equal(outcome.ran, false);
    assert.match(outcome.output, /exited with code 1/);
  });

  test("a check that crashes has no verdict", async () => {
    const outcome = await check(`throw new Error("the toolchain is broken");`);
    assert.equal(outcome.ran, false);
    assert.match(outcome.output, /the toolchain is broken/);
  });

  test("a check past its time limit has no verdict", async () => {
    const outcome = await check(`${write(JSON.parse(ACCEPTED))}\nsetInterval(() => {}, 1000);`, 2_000);
    assert.equal(outcome.ran, false);
    assert.match(outcome.output, /did not finish within 2s/);
  });

  for (const [what, text] of [
    ["two verdicts in the file", `${ACCEPTED}\n${ACCEPTED}\n`],
    ["a verdict with a key too many", '{"verdict":"accepted","problems":[],"deferred":[],"extra":1}'],
    ["a verdict with a key missing", '{"verdict":"accepted","problems":[]}'],
    ["an accepted verdict that lists problems", '{"verdict":"accepted","problems":["x"],"deferred":[]}'],
    ["a rejected verdict that lists none", '{"verdict":"rejected","problems":[],"deferred":[]}'],
    ["a verdict that is not one of the two", '{"verdict":"maybe","problems":[],"deferred":[]}'],
    ["text that is not JSON", "accepted"],
    ["an empty file", ""],
  ] as const) {
    test(`${what} is no verdict`, async () => {
      const outcome = await check(`fs.writeFileSync(file, ${JSON.stringify(text)});`);
      assert.equal(outcome.ran, false, `${what} was read as a verdict`);
      assert.equal(outcome.accepted, false);
    });
  }

  test("a second file beside the verdict is no verdict", async () => {
    const outcome = await check(`${write(JSON.parse(ACCEPTED))}\nfs.writeFileSync(file + ".2", "{}");`);
    assert.equal(outcome.ran, false);
  });

  test("a link in place of the verdict is no verdict", async () => {
    const elsewhere = path.join(tmp, "elsewhere.json");
    await fs.writeFile(elsewhere, ACCEPTED);
    const outcome = await check(`fs.symlinkSync(${JSON.stringify(elsewhere)}, file);`);
    assert.equal(outcome.ran, false);
  });

  test("the check is told the kind, the staged folder and a verdict path in a new, empty directory", async () => {
    const outcome = await check(
      `const dir = args[args.indexOf("--verdict-file") + 1].replace(/[^/]+$/, "");\n` +
        `fs.writeFileSync(file, JSON.stringify({ verdict: "accepted", problems: [], deferred: [JSON.stringify({ args, inDir: fs.readdirSync(dir) })] }));`,
    );
    assert.equal(outcome.ran, true, outcome.output);
    const { args, inDir } = JSON.parse(outcome.deferred[0]) as { args: string[]; inDir: string[] };
    assert.deepEqual(args.slice(0, 3), ["--check", "app", acmeDir]);
    assert.equal(args[3], "--verdict-file");
    assert.ok(path.isAbsolute(args[4]));
    assert.deepEqual(inDir, []);
    // And it is gone afterwards, verdict and all.
    await assert.rejects(fs.access(path.dirname(args[4])));
  });
});

// ── what the install does with the answer ───────────────────────────────────

describe("checkStagedTree: a refused copy is gone before the install stops", { concurrency: true }, () => {
  /** A lease whose checks pass, unless `lost`. */
  const lease = (lost = false): PlatformLease => ({
    async assertHeld() {
      if (lost) throw new LockLostError("repository.register");
    },
  });

  /** `<kind dir>/.installing-acme/acme/`, staged as stageTree() stages it. */
  async function stagedCopy(): Promise<{ dir: string; holder: string; staged: string }> {
    const kindDir = path.join(tmp, `apps-${n++}`);
    const holder = path.join(kindDir, ".installing-acme");
    const staged = path.join(holder, "acme");
    await fs.mkdir(staged, { recursive: true });
    await fs.writeFile(path.join(staged, "app.json"), '{"name":"Acme"}');
    return { dir: path.join(kindDir, "acme"), holder, staged };
  }

  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  test("rejected: deleted, and refused with the problems as the detail", async () => {
    const { dir, holder, staged } = await stagedCopy();
    const generator = await standIn(write({ verdict: "rejected", problems: ["apps/acme/a.ts:1 — fetch", "apps/acme/b.ts:2 — eval"], deferred: [] }));
    await assert.rejects(
      checkStagedTree("app", dir, staged, lease(), { generator }),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === "rejected-by-registry" &&
        err.detail === "apps/acme/a.ts:1 — fetch\napps/acme/b.ts:2 — eval",
    );
    assert.equal(await exists(holder), false);
    assert.equal(await exists(dir), false);
  });

  test("no verdict: deleted, and reported as this checkout's failure, not the extension's", async () => {
    const { dir, holder, staged } = await stagedCopy();
    const generator = await standIn(`console.error("tsx could not start"); process.exit(1);`);
    await assert.rejects(
      checkStagedTree("app", dir, staged, lease(), { generator }),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === "generator-failed" &&
        /could not complete its registry check/.test(err.message) &&
        /tsx could not start/.test(err.detail ?? ""),
    );
    assert.equal(await exists(holder), false);
  });

  test("accepted: left where it is, for placeTree() to move", async () => {
    const { dir, holder, staged } = await stagedCopy();
    const generator = await standIn(write({ verdict: "accepted", problems: [], deferred: ["later"] }));
    const outcome = await checkStagedTree("app", dir, staged, lease(), { generator });
    assert.equal(outcome.accepted, true);
    assert.deepEqual(outcome.deferred, ["later"]);
    assert.equal(await exists(path.join(staged, "app.json")), true);
    assert.equal(await exists(dir), false);
    assert.ok(await exists(holder));
  });

  test("rejected after the lock was lost: left for the next install of the slug to clear", async () => {
    const { dir, staged } = await stagedCopy();
    const generator = await standIn(write({ verdict: "rejected", problems: ["apps/acme/a.ts:1 — fetch"], deferred: [] }));
    await assert.rejects(
      checkStagedTree("app", dir, staged, lease(true), { generator }),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === "lock-lost" &&
        /\.installing-acme\/ is still on disk/.test(err.message),
    );
    assert.equal(await exists(path.join(staged, "app.json")), true);
  });
});
