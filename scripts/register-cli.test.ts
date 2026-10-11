/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `npm run register`: its arguments, a slug alone, what it prints and asks,
 * and its exit codes. runCli() is given a checkout of the test's own, a
 * stand-in for the registry generator, a stubbed database pool and its own
 * input and output. The last test runs the script itself.
 */

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutLockFile, readCheckoutLock, tryAcquireCheckoutLock } from "../src/lib/platform/checkout-lock";
import { filesHash, hashFileTree } from "../src/lib/repository/content-hash";
import { pendingLocation, writeSidecar, type PendingKind } from "../src/lib/repository/pending";
import type { TarEntry } from "../src/lib/repository/tar";
import { cliActor, parseArgs, printable, resolveTarget, runCli } from "./register-cli";

// ── the database: the register lock and the audit rows ──────────────────────

let audit: { actor_id: unknown; actor_email: unknown; action: unknown }[] = [];
(globalThis as { __pg?: unknown }).__pg = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert into public._platform_locks")) return [{ holder: values[1] }];
    if (text.startsWith("update public._platform_locks")) return [{ held: 1 }];
    if (text.startsWith("insert into public.admin_audit_log")) {
      audit.push({ actor_id: values[0], actor_email: values[1], action: values[2] });
    }
    return [];
  },
  { json: (value: unknown) => ({ json: value }) },
);

// ── checkouts, a generator, and a terminal ──────────────────────────────────

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-register-cli-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const STAND_IN = path.join(tmp, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : []);
fs.mkdirSync("src/generated", { recursive: true });
fs.writeFileSync("src/generated/app-registry.ts", JSON.stringify(list("apps").map((slug) => ({ slug })), null, 2));
fs.writeFileSync("src/generated/connector-registry.ts", JSON.stringify(list("connectors").map((name) => ({ name })), null, 2));
`,
);

let n = 0;
let root: string;
beforeEach(() => {
  root = path.join(tmp, `checkout-${n++}`);
  for (const dir of ["apps", "connectors"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  audit = [];
});

const TREE: TarEntry[] = [{ path: "app.json", mode: 0o644, data: Buffer.from('{"name":"Acme"}\n') }];

function pend(kind: PendingKind, slug: string) {
  const where = pendingLocation(root, kind, slug);
  fs.mkdirSync(where.folder, { recursive: true });
  for (const e of TREE) fs.writeFileSync(path.join(where.folder, e.path), e.data);
  writeSidecar(where.sidecar, {
    kind,
    slug,
    source: "https://mixos.org",
    version: "1.2.0",
    gitTag: null,
    commitSha: "d".repeat(40),
    contentHash: hashFileTree(TREE),
    filesHash: filesHash(TREE),
    requiresMixOS: null,
    yankedAccepted: false,
    installedAt: "2026-10-11T09:00:00.000Z",
    installedBy: "admin@example.com",
    fileCount: 1,
    byteCount: TREE[0].data.length,
    check: { verdict: "accepted", deferred: [] },
  });
  return where;
}

/** A terminal: what was printed, and the answers to give, in order. */
function terminal(answers: boolean[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    out,
    err,
    asked,
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      ask: async (question: string) => {
        asked.push(question);
        return answers.shift() ?? false;
      },
    },
  };
}

const cli = (args: string[], t = terminal()) =>
  runCli(args, { root, io: t.io, generator: STAND_IN, actor: { id: null, email: "cli:tester@test-host" } });

// ── arguments ───────────────────────────────────────────────────────────────

describe("arguments", () => {
  test("each command, and what isn't one", () => {
    assert.deepEqual(parseArgs([]), { mode: "list" });
    assert.deepEqual(parseArgs(["app/acme"]), { mode: "register", target: "app/acme" });
    assert.deepEqual(parseArgs(["app/acme", "--discard"]), { mode: "discard", target: "app/acme" });
    assert.deepEqual(parseArgs(["--discard", "acme"]), { mode: "discard", target: "acme" });
    assert.deepEqual(parseArgs(["--recover"]), { mode: "recover" });
    assert.deepEqual(parseArgs(["--break-lock"]), { mode: "break-lock" });
    for (const bad of [["--force"], ["--discard"], ["--recover", "acme"], ["a", "b"], ["--recover", "--break-lock"], ["acme", "--discard", "--discard"]]) {
      assert.ok("error" in parseArgs(bad), bad.join(" "));
    }
  });

  test("a usage error exits 2 and prints the usage", async () => {
    const t = terminal();
    assert.equal(await cli(["--force"], t), 2);
    assert.match(t.err.join("\n"), /Unknown option --force\.[\s\S]*Usage:/);
  });
});

describe("naming what to register", () => {
  test("<kind>/<slug>, singular or plural", () => {
    assert.deepEqual(resolveTarget(root, "app/acme"), { kind: "app", slug: "acme" });
    assert.deepEqual(resolveTarget(root, "connectors/acme"), { kind: "connector", slug: "acme" });
    assert.match((resolveTarget(root, "theme/aurora") as { error: string }).error, /registered when it is installed/);
    assert.ok("error" in resolveTarget(root, "widget/acme"));
    assert.ok("error" in resolveTarget(root, "app/../x"));
  });

  test("a slug alone, when exactly one kind has it pending", () => {
    assert.match((resolveTarget(root, "acme") as { error: string }).error, /Nothing named acme/);
    pend("connector", "acme");
    assert.deepEqual(resolveTarget(root, "acme"), { kind: "connector", slug: "acme" });
    pend("app", "acme");
    assert.match((resolveTarget(root, "acme") as { error: string }).error, /Say app\/acme or connector\/acme/);
  });
});

// ── what it does ────────────────────────────────────────────────────────────

describe("running it", () => {
  test("with no arguments, lists what is pending and how to register each", async () => {
    pend("app", "acme");
    const t = terminal();
    assert.equal(await cli([], t), 0);
    assert.match(t.out.join("\n"), /app\/acme 1\.2\.0, installed .* by admin@example\.com\n {4}npm run register -- app\/acme/);
  });

  test("registers by slug alone, and says what to do next", async () => {
    pend("app", "acme");
    const t = terminal();
    assert.equal(await cli(["acme"], t), 0, t.err.join("\n"));
    assert.match(t.out.join("\n"), /Registered app\/acme 1\.2\.0 from commit dddddddddddd\./);
    assert.match(t.out.join("\n"), /commit apps\/acme and deploy/);
    assert.ok(fs.existsSync(path.join(root, "apps", "acme", "app.json")));
    assert.deepEqual(audit, [{ actor_id: null, actor_email: "cli:tester@test-host", action: "app.register" }]);
  });

  test("a refusal exits 1 with the reason", async () => {
    const where = pend("app", "acme");
    fs.writeFileSync(path.join(where.folder, "app.json"), '{"name":"Changed"}\n');
    const t = terminal();
    assert.equal(await cli(["app/acme"], t), 1);
    assert.match(t.err.join("\n"), /changed since it was installed/);
  });

  test("--discard deletes it", async () => {
    const where = pend("connector", "probe");
    const t = terminal();
    assert.equal(await cli(["connector/probe", "--discard"], t), 0);
    assert.match(t.out.join("\n"), /Discarded connector\/probe/);
    assert.equal(fs.existsSync(where.folder), false);
    assert.equal(audit[0].action, "connector.discard");
  });

  test("--recover shows what it found, asks, and acts on a yes", async () => {
    const where = pend("app", "acme");
    fs.rmSync(where.sidecar);
    const no = terminal([false]);
    assert.equal(await cli(["--recover"], no), 1);
    assert.match(no.out.join("\n"), /Found:[\s\S]*has no record of what install verified[\s\S]*Nothing was changed/);
    assert.ok(fs.existsSync(where.folder));

    const yes = terminal([true]);
    assert.equal(await cli(["--recover"], yes), 0);
    assert.match(yes.out.join("\n"), /Done: \.mixos\/pending\/apps\/acme\./);
    assert.equal(fs.existsSync(where.folder), false);
  });

  test("--recover in a tidy checkout says there is nothing to do", async () => {
    const t = terminal();
    assert.equal(await cli(["--recover"], t), 0);
    assert.deepEqual(t.asked, []);
    assert.match(t.out.join("\n"), /Nothing to recover/);
  });
});

describe("--break-lock", () => {
  test("with no lock, says so", async () => {
    const t = terminal();
    assert.equal(await cli(["--break-lock"], t), 0);
    assert.match(t.out.join("\n"), /isn't locked/);
    assert.deepEqual(t.asked, []);
  });

  test("shows a running holder on this machine, warns, and keeps the lock on a no", async () => {
    const held = tryAcquireCheckoutLock(root, "the registry generator");
    const t = terminal([false]);
    assert.equal(await cli(["--break-lock"], t), 1);
    assert.match(t.out.join("\n"), /held by the registry generator \(pid \d+ on this machine/);
    assert.match(t.out.join("\n"), /still running/);
    assert.deepEqual(t.asked, ["Break the lock?"]);
    assert.equal(readCheckoutLock(root).holder?.token, held.token);
    held.release();
  });

  test("shows a lock from another machine as one nothing here can check, and removes it on a yes", async () => {
    fs.mkdirSync(path.join(root, ".mixos"));
    fs.writeFileSync(
      checkoutLockFile(root),
      JSON.stringify({ pid: 7, hostname: "a-dev-container", token: "0123456789abcdef-away", purpose: "an install of app/acme from the Registry", since: new Date().toISOString() }),
    );
    const t = terminal([true]);
    assert.equal(await cli(["--break-lock"], t), 0);
    assert.match(t.out.join("\n"), /another machine, a-dev-container/);
    assert.match(t.out.join("\n"), /can tell whether that process is still running/);
    assert.match(t.out.join("\n"), /Removed the checkout lock/);
    assert.equal(readCheckoutLock(root).exists, false);
  });

  test("a lock file that can't be read is shown as such, and removed on a yes", async () => {
    fs.mkdirSync(path.join(root, ".mixos"));
    fs.writeFileSync(checkoutLockFile(root), "");
    const t = terminal([true]);
    assert.equal(await cli(["--break-lock"], t), 0);
    assert.match(t.out.join("\n"), /can't be read as one/);
    assert.equal(readCheckoutLock(root).exists, false);
  });
});

describe("what it prints", () => {
  test("control and bidi characters from files and hostnames are shown escaped", () => {
    assert.equal(printable("a‮b\u0007c"), "a\\u{202E}b\\u{7}c");
    assert.equal(printable("two\nlines"), "two\nlines");
  });

  test("the audit actor is cli:<os user>@<hostname>, with no user id", () => {
    const actor = cliActor();
    assert.equal(actor.id, null);
    assert.match(actor.email, /^cli:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/);
  });
});

describe("the script", () => {
  test("npm run register with an option it doesn't know exits 2, before reaching a database", () => {
    const repo = path.resolve(__dirname, "..");
    const run = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules", "tsx", "dist", "cli.mjs"), path.join(__dirname, "register.ts"), "--frobnicate"],
      // From the checkout, as `npm run` starts it: tsx finds the project's
      // tsconfig.json, and with it the `@/` paths, from where it starts.
      { cwd: path.join(repo, "apps"), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmp } as unknown as NodeJS.ProcessEnv },
    );
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /Unknown option --frobnicate/);
  });
});
