/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Register, Discard and recovery, each in a checkout of its own, against a
 * stand-in for the registry generator and a stubbed database pool.
 *
 * The stand-in checks the lock token it is handed against `.mixos/lock`,
 * records what it saw, and "registers" every folder in apps/ and connectors/
 * unless a test tells it otherwise, by writing the two generated registry
 * modules Register reads. The pool answers the register lock's statements and
 * keeps the audit rows. register.integration.test.ts runs the same against a
 * real Postgres.
 */

import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliActorName } from "../apps/audit-actors";
import { tryAcquireCheckoutLock, readCheckoutLock } from "../platform/checkout-lock";
import { filesHash, hashFileTree } from "./content-hash";
import {
  INSTALL_RECORD_FILE,
  readInstallRecord,
  serializeInstallRecord,
  type InstallRecord,
} from "./install-record";
import {
  pendingLocation,
  readSidecar,
  writeSidecar,
  type PendingKind,
  type PendingSidecar,
  type Registering,
} from "./pending";
import {
  RegisterError,
  discardPending,
  describeRegisterFailure,
  planRecovery,
  recoverCheckout,
  registerPending,
  type RecoveryItem,
} from "./register";
import type { TarEntry } from "./tar";

// ── the database ────────────────────────────────────────────────────────────

interface AuditRow {
  actor_id: unknown;
  actor_email: unknown;
  action: string;
  target_type: unknown;
  target_id: unknown;
  details: Record<string, unknown>;
}

let audit: AuditRow[] = [];
/** The register lock's statements, with when each ran. */
let lockLog: { what: "take" | "renew" | "release"; at: number }[] = [];
/** Set to make the register lock read as held by someone else. */
let rowLockTaken = false;

const pool = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert into public._platform_locks")) {
      if (rowLockTaken) return [];
      lockLog.push({ what: "take", at: Date.now() });
      return [{ holder: values[1] }];
    }
    if (text.startsWith("update public._platform_locks")) {
      lockLog.push({ what: "renew", at: Date.now() });
      return [{ held: 1 }];
    }
    if (text.startsWith("delete from public._platform_locks")) {
      lockLog.push({ what: "release", at: Date.now() });
      return [];
    }
    if (text.startsWith("insert into public.admin_audit_log")) {
      audit.push({
        actor_id: values[0],
        actor_email: values[1],
        action: values[2] as string,
        target_type: values[3],
        target_id: values[4],
        details: (values[5] as { json: Record<string, unknown> }).json,
      });
      return [];
    }
    throw new Error(`unexpected statement: ${text}`);
  },
  { json: (value: unknown) => ({ json: value }) },
);
(globalThis as { __pg?: unknown }).__pg = pool;

// ── checkouts ───────────────────────────────────────────────────────────────

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-register-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * The stand-in generator. `behaviour.json` in the checkout steers it: `refuse`
 * (slugs to leave out), `exit` (a code to stop with), `hang` (never finish),
 * `breakLock` (replace the lock file, as a hand would).
 */
const STAND_IN = path.join(tmp, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const args = process.argv.slice(2);
const token = args[args.indexOf("--lock-token") + 1];
const lock = JSON.parse(fs.readFileSync(".mixos/lock", "utf8"));
const behaviour = fs.existsSync("behaviour.json") ? JSON.parse(fs.readFileSync("behaviour.json", "utf8")) : {};
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : []);
fs.appendFileSync("runs.log", JSON.stringify({
  at: Date.now(),
  tokenMatches: lock.token === token && lock.pid !== process.pid,
  apps: list("apps"),
  connectors: list("connectors"),
  env: Object.keys(process.env).filter((k) => !k.startsWith("__CF_")).sort(),
}) + "\\n");
if (behaviour.breakLock) fs.writeFileSync(".mixos/lock", JSON.stringify({ ...lock, token: "someone-else-0123456789" }));
if (behaviour.exit) process.exit(behaviour.exit);
if (behaviour.hang) setInterval(() => {}, 1000);
else {
  const refuse = behaviour.refuse ?? [];
  const keep = (dir) => list(dir).filter((n) => !refuse.includes(n));
  fs.mkdirSync("src/generated", { recursive: true });
  fs.writeFileSync("src/generated/app-registry.ts", "export const appRegistry = " + JSON.stringify(keep("apps").map((slug) => ({ slug })), null, 2) + ";\\n");
  fs.writeFileSync("src/generated/connector-registry.ts", "export const connectorRegistry = " + JSON.stringify(keep("connectors").map((name) => ({ name })), null, 2) + ";\\n");
}
`,
);

let n = 0;
let root: string;

beforeEach(() => {
  root = path.join(tmp, `checkout-${n++}`);
  for (const dir of ["apps", "connectors", "themes"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  audit = [];
  lockLog = [];
  rowLockTaken = false;
});
afterEach(() => {
  delete process.env.INSTALL_APPS;
});

const ACTOR = { id: null, email: cliActorName("tester", "test-host") };
const options = (extra: Partial<Parameters<typeof registerPending>[2]> = {}) => ({
  actor: ACTOR,
  via: "cli" as const,
  root,
  generator: STAND_IN,
  notice: () => {},
  ...extra,
});

const file = (p: string, data: string): TarEntry => ({ path: p, mode: 0o644, data: Buffer.from(data) });
const ACME = [file("app.json", '{"name":"Acme"}\n'), file("api/items/route.ts", "export {};\n")];

/** The install record install writes for `entries` as `kind`/`slug`. */
function recordFor(kind: PendingKind, slug: string, entries: TarEntry[], fields: Partial<InstallRecord> = {}): InstallRecord {
  return {
    source: "https://mixos.org",
    kind,
    slug,
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "c".repeat(40),
    contentHash: hashFileTree(entries),
    filesHash: filesHash(entries),
    repository: { owner: "acme", name: "mixos-apps", subpath: `apps/${slug}` },
    requiresMixOS: null,
    ...fields,
  };
}

/** A pending install, as install leaves one: the tree with its record, and the sidecar beside it. */
function pend(
  kind: PendingKind,
  slug: string,
  entries: TarEntry[] = ACME,
  { record = {}, ...fields }: Partial<PendingSidecar> & { record?: Partial<InstallRecord> } = {},
) {
  const where = pendingLocation(root, kind, slug);
  fs.mkdirSync(where.folder, { recursive: true });
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(where.folder, e.path)), { recursive: true });
    fs.writeFileSync(path.join(where.folder, e.path), e.data, { mode: 0o644 });
  }
  fs.writeFileSync(
    path.join(where.folder, INSTALL_RECORD_FILE),
    serializeInstallRecord(recordFor(kind, slug, entries, record)),
  );
  writeSidecar(where.sidecar, {
    kind,
    slug,
    yankedAccepted: false,
    installedAt: "2026-10-11T09:00:00.000Z",
    installedBy: "admin@example.com",
    check: { verdict: "accepted", deferred: ["apps/acme/widgets.ts: later"] },
    ...fields,
  });
  return where;
}

const behave = (b: Record<string, unknown>) => fs.writeFileSync(path.join(root, "behaviour.json"), JSON.stringify(b));
const runs = () =>
  fs.existsSync(path.join(root, "runs.log"))
    ? fs.readFileSync(path.join(root, "runs.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

/** A pid that was running a moment ago and isn't now. */
function deadPid(): number {
  return Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

function rejectedWith(code: string) {
  return (err: unknown) => describeRegisterFailure(err).code === code;
}

// ── Register ────────────────────────────────────────────────────────────────

describe("Register", () => {
  test("moves a pending app into place with its install record and registers it, then deletes its sidecar", async () => {
    const where = pend("app", "acme");
    const result = await registerPending("app", "acme", options());

    assert.equal(result.installPath, "apps/acme");
    assert.equal(result.registry.ok, true);
    assert.equal(result.version, "1.2.0");
    assert.deepEqual(result.deferred, ["apps/acme/widgets.ts: later"]);
    assert.equal(exists("apps/acme/app.json"), true);
    assert.equal(fs.existsSync(where.folder), false);
    assert.equal(fs.existsSync(where.sidecar), false);
    // The record moved with the folder, to be committed with it.
    assert.deepEqual(readInstallRecord(path.join(root, "apps", "acme")), { state: "ok", record: recordFor("app", "acme", ACME) });
    assert.deepEqual(result.record, recordFor("app", "acme", ACME));
    assert.match(result.nextStep, /^Registered to apps\/acme: the registry generator loaded its code and accepted it\. It is off until/);
    // No lock left behind.
    assert.equal(readCheckoutLock(root).exists, false);
  });

  test("hands back what to commit: the files with sizes, a message from the record, and the commands", async () => {
    pend("app", "acme");
    const { handBack } = await registerPending("app", "acme", options());
    assert.equal(handBack.folder, "apps/acme");
    assert.deepEqual(
      handBack.files.map((f) => f.path),
      [INSTALL_RECORD_FILE, "api/items/route.ts", "app.json"],
    );
    assert.equal(handBack.fileCount, 3);
    assert.equal(handBack.commitMessage.split("\n")[0], "feat(acme): add app acme 1.2.0 from mixos.org");
    assert.match(handBack.commitMessage, /^Registry-Files-Hash: sha256-/m);
    assert.match(handBack.commands, /^git switch -c add-app-acme\ngit add apps\/acme\n/);
    assert.equal(handBack.sourceUrl, `https://github.com/acme/mixos-apps/tree/${"c".repeat(40)}/apps/acme`);
  });

  test("runs the generator once, under its own checkout lock by token, with PATH and TMPDIR only", async () => {
    pend("app", "acme");
    await registerPending("app", "acme", options());
    const [run, ...more] = runs();
    assert.deepEqual(more, []);
    assert.equal(run.tokenMatches, true);
    assert.deepEqual(run.apps, ["acme"]);
    assert.deepEqual(run.env.filter((k: string) => k !== "PATH" && k !== "TMPDIR"), []);
  });

  test("holds the register lock throughout: taken before the generator ran, released after", async () => {
    pend("app", "acme");
    await registerPending("app", "acme", options());
    const [run] = runs();
    const taken = lockLog.find((l) => l.what === "take")!;
    const released = lockLog.find((l) => l.what === "release")!;
    assert.ok(taken.at <= run.at && run.at <= released.at, JSON.stringify({ lockLog, run }));
    // Renewed (confirmed) before each change to the disk.
    assert.ok(lockLog.filter((l) => l.what === "renew").length >= 2);
  });

  test("is audited with the CLI's actor: no user id, and a name that is not an address", async () => {
    pend("app", "acme");
    await registerPending("app", "acme", options());
    assert.equal(audit.length, 1);
    const [row] = audit;
    assert.equal(row.actor_id, null);
    assert.equal(row.actor_email, "cli:tester@test-host");
    assert.equal(row.action, "app.register");
    assert.equal(row.target_type, "app");
    assert.equal(row.target_id, "acme");
    assert.equal(row.details.via, "cli");
    assert.equal(row.details.filesHash, filesHash(ACME));
    assert.equal(row.details.installPath, "apps/acme");
    assert.equal(row.details.installedBy, "admin@example.com");
  });

  test("registers a pending connector into connectors/", async () => {
    const tree = [file("connector.json", '{"name":"probe"}\n'), file("index.ts", "export {};\n")];
    pend("connector", "probe", tree);
    const result = await registerPending("connector", "probe", options());
    assert.equal(result.installPath, "connectors/probe");
    assert.equal(exists("connectors/probe/connector.json"), true);
    assert.equal(audit[0].action, "connector.register");
  });

  test("refuses a pending folder changed after install: the files hash no longer matches", async () => {
    const where = pend("app", "acme");
    fs.appendFileSync(path.join(where.folder, "api/items/route.ts"), "globalThis.x = 1;\n");
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "changed" &&
      /changed since it was installed/.test(err.message) &&
      /expected sha256-[\s\S]*\n[\s\S]*found +sha256-/.test(err.detail ?? ""),
    );
    // Nothing moved and nothing ran.
    assert.equal(exists("apps/acme"), false);
    assert.equal(fs.existsSync(where.folder), true);
    assert.deepEqual(runs(), []);
    assert.equal(audit[0].action, "app.register.rejected");
    assert.equal(audit[0].details.reason, "changed");
  });

  test("refuses a pending folder with a file added, or a link in it", async () => {
    const added = pend("app", "acme");
    fs.writeFileSync(path.join(added.folder, "api/items/extra.ts"), "export {};\n");
    await assert.rejects(registerPending("app", "acme", options()), rejectedWith("changed"));

    const linked = pend("app", "other");
    fs.symlinkSync("/etc/hosts", path.join(linked.folder, "hosts.ts"));
    await assert.rejects(registerPending("app", "other", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "changed" && /symbolic link/.test(err.detail ?? ""),
    );
  });

  test("a refused registration is put back in pending, its record cleared, and the registry regenerated", async () => {
    const where = pend("app", "acme");
    behave({ refuse: ["acme"] });
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "rejected-by-registry" && /put back in pending/.test(err.message),
    );
    assert.equal(exists("apps/acme"), false);
    assert.equal(fs.existsSync(where.folder), true);
    const read = readSidecar(where.sidecar);
    assert.equal(read.state, "ok");
    assert.equal(read.state === "ok" && read.sidecar.register, undefined);
    // The registration's run, then the one that restored the registry.
    const [first, second] = runs();
    assert.deepEqual(first.apps, ["acme"]);
    assert.deepEqual(second.apps, []);
    assert.equal(audit[0].details.reason, "rejected-by-registry");
  });

  test("a generator that stops puts it back too, and says it could be either the code or the checkout", async () => {
    const where = pend("app", "acme");
    behave({ exit: 3 });
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "generator-failed" &&
      /that code or about this checkout/.test(err.message) &&
      /Regenerating the registry afterwards failed too/.test(err.message),
    );
    assert.equal(fs.existsSync(where.folder), true);
    assert.equal(exists("apps/acme"), false);
  });

  test("requiresMixOS above this checkout's version, from the record, is refused before anything moves", async () => {
    pend("app", "acme", ACME, { record: { requiresMixOS: "999.0.0" } });
    await assert.rejects(registerPending("app", "acme", options()), rejectedWith("incompatible"));
    assert.equal(exists("apps/acme"), false);
    assert.deepEqual(runs(), []);
  });

  test("refuses when something is already where it would go", async () => {
    pend("app", "acme");
    fs.mkdirSync(path.join(root, "apps", "acme"));
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "already-registered" && /--discard/.test(err.message),
    );
  });

  test("refuses what isn't pending, and a pending folder with no record of what was verified", async () => {
    await assert.rejects(registerPending("app", "ghost", options()), rejectedWith("not-pending"));
    const where = pend("app", "acme");
    fs.rmSync(where.sidecar);
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "unregistrable" && /--discard/.test(err.message),
    );
    await assert.rejects(registerPending("theme", "aurora", options()), rejectedWith("not-pending"));
  });

  test("refuses a pending folder whose install record is missing, unreadable or another's, and moves nothing", async () => {
    const missing = pend("app", "missing");
    fs.rmSync(path.join(missing.folder, INSTALL_RECORD_FILE));
    await assert.rejects(registerPending("app", "missing", options()), (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "unregistrable" &&
      /has no install record/.test(err.message) &&
      /npm run register -- app\/missing --discard. and install it again/.test(err.message),
    );

    const unreadable = pend("app", "unreadable");
    fs.writeFileSync(path.join(unreadable.folder, INSTALL_RECORD_FILE), '{"version":"latest"}');
    await assert.rejects(registerPending("app", "unreadable", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "unregistrable" && /can't be read/.test(err.message),
    );

    pend("app", "borrowed", ACME, { record: { slug: "other" } });
    await assert.rejects(registerPending("app", "borrowed", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "unregistrable" && /it records app\/other, not app\/borrowed/.test(err.message),
    );

    for (const slug of ["missing", "unreadable", "borrowed"]) assert.equal(exists(`apps/${slug}`), false, slug);
    assert.deepEqual(runs(), []);
  });

  test("refuses a pending install an earlier version made, with no record in its folder", async () => {
    const where = pend("app", "acme");
    fs.rmSync(path.join(where.folder, INSTALL_RECORD_FILE));
    // What its sidecar held then: the release's facts.
    fs.writeFileSync(
      where.sidecar,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(where.sidecar, "utf8")),
        source: "https://mixos.org",
        version: "1.2.0",
        gitTag: "v1.2.0",
        commitSha: "c".repeat(40),
        contentHash: hashFileTree(ACME),
        filesHash: filesHash(ACME),
        requiresMixOS: null,
        fileCount: ACME.length,
        byteCount: 30,
      }),
    );
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "unregistrable" &&
      /installed by an earlier version of MixOS/.test(err.message) &&
      /--discard. and install it again/.test(err.message),
    );
    assert.equal(exists("apps/acme"), false);
  });

  test("the files hash leaves the record out: editing the record alone changes nothing it checks", async () => {
    const where = pend("app", "acme");
    // A hand edit to the record changes what it says, not the files it was checked against.
    const file = path.join(where.folder, INSTALL_RECORD_FILE);
    fs.writeFileSync(file, serializeInstallRecord(recordFor("app", "acme", ACME, { version: "1.2.1" })));
    const result = await registerPending("app", "acme", options());
    assert.equal(result.version, "1.2.1");
    assert.equal(result.filesHash, filesHash(ACME));
  });

  test("is off with the kind's install flag", async () => {
    pend("app", "acme");
    process.env.INSTALL_APPS = "false";
    await assert.rejects(registerPending("app", "acme", options()), rejectedWith("disabled"));
    assert.deepEqual(lockLog, []);
  });

  test("is refused while another process holds the checkout lock, naming it, and changes nothing", async () => {
    const where = pend("app", "acme");
    const held = tryAcquireCheckoutLock(root, "the registry generator");
    try {
      await assert.rejects(registerPending("app", "acme", options()), (err: unknown) => {
        const failure = describeRegisterFailure(err);
        return failure.code === "locked" && /the registry generator/.test(failure.message);
      });
    } finally {
      held.release();
    }
    assert.equal(fs.existsSync(where.folder), true);
    assert.deepEqual(runs(), []);
    assert.equal(audit[0].details.reason, "locked");
  });

  test("is refused while the register lock is held in the database, before the checkout lock is taken", async () => {
    pend("app", "acme");
    rowLockTaken = true;
    await assert.rejects(registerPending("app", "acme", options()), rejectedWith("locked"));
    assert.equal(readCheckoutLock(root).exists, false);
  });

  test("a checkout lock broken while the generator ran stops it before putting anything back", async () => {
    const where = pend("app", "acme");
    behave({ refuse: ["acme"], breakLock: true });
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "lock-lost" && /--recover/.test(err.message),
    );
    // Left as it was when the lock went, for recovery.
    assert.equal(exists("apps/acme"), true);
    const read = readSidecar(where.sidecar);
    assert.equal(read.state === "ok" && read.sidecar.register?.pid, process.pid);
    assert.equal(runs().length, 1);
  });

  test("stopped (Ctrl-C) during the generator run: ends the run and stops at the next safe point", async () => {
    const where = pend("app", "acme");
    behave({ hang: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);
    await assert.rejects(registerPending("app", "acme", options({ signal: controller.signal })), (err: unknown) =>
      err instanceof RegisterError && err.code === "stopped" && /--recover/.test(err.message),
    );
    assert.equal(exists("apps/acme"), true);
    const read = readSidecar(where.sidecar);
    assert.ok(read.state === "ok" && read.sidecar.register);
    // Both locks released on the way out.
    assert.equal(readCheckoutLock(root).exists, false);
    assert.equal(lockLog.at(-1)?.what, "release");
  });

  test("a registration left midway refuses Register and Discard until it is recovered", async () => {
    pend("app", "acme", ACME, {
      register: { token: "0123456789abcdef-gone", pid: deadPid(), hostname: os.hostname(), startedAt: new Date().toISOString() },
    });
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "interrupted" && /--recover/.test(err.message),
    );
    await assert.rejects(discardPending("app", "acme", options()), rejectedWith("interrupted"));
  });
});

// ── Discard ─────────────────────────────────────────────────────────────────

describe("Discard", () => {
  test("deletes the pending folder and its record, under both locks, and is audited", async () => {
    const where = pend("app", "acme");
    const result = await discardPending("app", "acme", options());
    assert.equal(result.pendingPath, ".mixos/pending/apps/acme");
    assert.equal(fs.existsSync(where.folder), false);
    assert.equal(fs.existsSync(where.sidecar), false);
    assert.deepEqual(runs(), []);
    assert.deepEqual(lockLog.map((l) => l.what).filter((w) => w !== "renew"), ["take", "release"]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "app.discard");
    assert.equal(audit[0].actor_id, null);
    assert.equal(audit[0].actor_email, "cli:tester@test-host");
    assert.equal(audit[0].details.via, "cli");
    assert.equal(audit[0].details.filesHash, filesHash(ACME));
  });

  test("deletes a pending folder whose record is gone, saying so in the audit row", async () => {
    const where = pend("connector", "probe");
    fs.rmSync(where.sidecar);
    await discardPending("connector", "probe", options());
    assert.equal(fs.existsSync(where.folder), false);
    assert.equal(audit[0].details.record, "missing or unreadable");
  });

  test("refuses what isn't pending, and audits nothing", async () => {
    await assert.rejects(discardPending("app", "ghost", options()), rejectedWith("not-pending"));
    assert.deepEqual(audit, []);
  });
});

// ── recovery ────────────────────────────────────────────────────────────────

describe("recovery", () => {
  const stoppedHere = (): Registering => ({
    token: "0123456789abcdef-stopped",
    pid: deadPid(),
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  });
  const yes = async () => true;

  test("a registration that stopped after the move is put back in pending and the registry regenerated", async () => {
    const where = pend("app", "acme", ACME, { register: stoppedHere() });
    fs.renameSync(where.folder, path.join(root, "apps", "acme"));

    let shown: RecoveryItem[] = [];
    const result = await recoverCheckout({ ...options(), confirm: async (items) => ((shown = items), true) });
    assert.deepEqual(shown.map((i) => [i.action, i.path]), [["return-to-pending", "apps/acme"]]);
    assert.equal(result.acted.length, 1);
    assert.equal(result.regenerated?.ok, true);
    assert.equal(exists("apps/acme"), false);
    assert.equal(fs.existsSync(where.folder), true);
    const read = readSidecar(where.sidecar);
    assert.equal(read.state === "ok" && read.sidecar.register, undefined);
    assert.deepEqual(runs()[0].apps, []);
    assert.equal(audit[0].action, "app.register.recover");
    assert.equal(audit[0].details.action, "return-to-pending");
    // And it can be registered now.
    await registerPending("app", "acme", options());
    assert.equal(exists("apps/acme"), true);
  });

  test("a registration that stopped before the move keeps it pending, with its record cleared", async () => {
    const where = pend("app", "acme", ACME, { register: stoppedHere() });
    const result = await recoverCheckout({ ...options(), confirm: yes });
    assert.deepEqual(result.acted.map((i) => i.action), ["clear-record"]);
    const read = readSidecar(where.sidecar);
    assert.equal(read.state === "ok" && read.sidecar.register, undefined);
    assert.equal(fs.existsSync(where.folder), true);
  });

  test("clears a record whose folder is gone, a folder with no record, staged copies and half-written files", async () => {
    const orphanRecord = pend("app", "gone");
    fs.rmSync(orphanRecord.folder, { recursive: true });
    const orphanFolder = pend("connector", "bare");
    fs.rmSync(orphanFolder.sidecar);
    const staged = path.join(root, ".mixos", "staging", "themes", "aurora");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(path.dirname(orphanRecord.sidecar), ".acme.json.1234.tmp"), "{");
    fs.writeFileSync(path.join(root, ".mixos", "lock.stale-0f0f"), "{}");

    const result = await recoverCheckout({ ...options(), confirm: yes });
    assert.deepEqual(result.acted.map((i) => i.action).sort(), ["drop-folder", "drop-record", "drop-staging", "drop-temp", "drop-temp"]);
    assert.equal(fs.existsSync(orphanRecord.sidecar), false);
    assert.equal(fs.existsSync(orphanFolder.folder), false);
    assert.equal(fs.existsSync(staged), false);
    assert.deepEqual(fs.readdirSync(path.join(root, ".mixos", "pending", "apps")), []);
    assert.equal(fs.existsSync(path.join(root, ".mixos", "lock.stale-0f0f")), false);
    // Nothing moved out of the build, so nothing to regenerate. Only the
    // pending installs are audited.
    assert.equal(result.regenerated, null);
    assert.deepEqual(audit.map((r) => `${r.action} ${r.target_id}`).sort(), ["app.register.recover gone", "connector.register.recover bare"]);
  });

  test("leaves alone a record whose registration is still running on this machine", async () => {
    pend("app", "acme", ACME, {
      register: { token: "0123456789abcdef-live", pid: process.ppid, hostname: os.hostname(), startedAt: new Date().toISOString() },
    });
    let asked = false;
    const result = await recoverCheckout({ ...options(), confirm: async () => (asked = true) });
    assert.equal(asked, false);
    assert.deepEqual(result.acted, []);
    assert.match(result.items[0].blocked ?? "", /still running/);
  });

  test("asks with a warning about a record from another machine, which it can't check", async () => {
    pend("app", "acme", ACME, {
      register: { token: "0123456789abcdef-away", pid: 1, hostname: "a-dev-container", startedAt: new Date().toISOString() },
    });
    let warned = "";
    const result = await recoverCheckout({ ...options(), confirm: async (items) => ((warned = items[0].warning ?? ""), true) });
    assert.match(warned, /another machine, a-dev-container/);
    assert.deepEqual(result.acted.map((i) => i.action), ["clear-record"]);
  });

  test("a no changes nothing", async () => {
    const where = pend("app", "acme", ACME, { register: stoppedHere() });
    fs.renameSync(where.folder, path.join(root, "apps", "acme"));
    const result = await recoverCheckout({ ...options(), confirm: async () => false });
    assert.equal(result.cancelled, true);
    assert.equal(exists("apps/acme"), true);
    assert.deepEqual(lockLog, []);
    assert.deepEqual(audit, []);
  });

  test("does nothing when the checkout changed while it asked", async () => {
    const where = pend("app", "acme", ACME, { register: stoppedHere() });
    await assert.rejects(
      recoverCheckout({
        ...options(),
        confirm: async () => {
          fs.rmSync(where.folder, { recursive: true });
          return true;
        },
      }),
      rejectedWith("changed-meanwhile"),
    );
    assert.equal(fs.existsSync(where.sidecar), true);
  });

  test("leaves both copies to a person when the pending and the live folder are both there", async () => {
    const where = pend("app", "acme", ACME, { register: stoppedHere() });
    fs.cpSync(where.folder, path.join(root, "apps", "acme"), { recursive: true });
    const items = planRecovery(root);
    assert.equal(items[0].action, "resolve-by-hand");
    assert.match(items[0].blocked ?? "", /can't tell which copy to keep/);
  });

  test("finds nothing in a tidy checkout", async () => {
    pend("app", "acme");
    assert.deepEqual(planRecovery(root), []);
    const result = await recoverCheckout({ ...options(), confirm: yes });
    assert.deepEqual(result, { items: [], acted: [], cancelled: false, regenerated: null });
  });

  test("takes over the checkout lock a stopped process left on this machine, and says so", async () => {
    pend("app", "acme", ACME, { register: stoppedHere() });
    const lockFile = path.join(root, ".mixos", "lock");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: deadPid(), hostname: os.hostname(), token: "0123456789abcdef-dead", purpose: "npm run register", since: new Date().toISOString() }),
    );
    const notices: string[] = [];
    await recoverCheckout({ ...options({ notice: (m) => notices.push(m) }), confirm: yes });
    assert.match(notices.join("\n"), /Took over the checkout lock from npm run register/);
    assert.equal(fs.existsSync(lockFile), false);
  });
});
