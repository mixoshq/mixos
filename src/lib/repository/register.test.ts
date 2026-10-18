/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Register, Discard and recovery, each in a checkout of its own, against a
 * stand-in for the registry generator and a stubbed database pool.
 *
 * The stand-in checks the lock token it is handed against `.mixos/lock`,
 * records what it saw (the folders in apps/ and connectors/, and the release
 * each folder in apps/ and in its backups holds), and "registers" every folder
 * in apps/ and connectors/ unless a test tells it otherwise, by writing the two
 * generated registry modules Register reads. The pool answers the register lock's statements and
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
import { backupLocation, readBackupRecord, writeBackupRecord } from "./backup";
import { filesHash, hashFileTree } from "./content-hash";
import {
  INSTALL_RECORD_FILE,
  folderFilesHash,
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
  type Replaces,
} from "./pending";
import {
  RegisterError,
  discardPending,
  describeRegisterFailure,
  planRecovery,
  recoverCheckout,
  registerPending,
  updateRecordFor,
  type RecoveryItem,
} from "./register";
import { RemoveError, planRemoval } from "./remove";
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
 * `hangFirst` (the first run never finishes), `breakLock` (replace the lock
 * file, as a hand would).
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
const version = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(dir + "/.registry.json", "utf8")).version;
  } catch {
    return null;
  }
};
const versions = (dir) => Object.fromEntries(list(dir).filter((n) => !n.endsWith(".json")).map((n) => [n, version(dir + "/" + n)]));
fs.appendFileSync("runs.log", JSON.stringify({
  at: Date.now(),
  tokenMatches: lock.token === token && lock.pid !== process.pid,
  apps: list("apps"),
  connectors: list("connectors"),
  versions: versions("apps"),
  backup: versions(".mixos/backup/apps"),
  env: Object.keys(process.env).filter((k) => !k.startsWith("__CF_")).sort(),
}) + "\\n");
const first = fs.readFileSync("runs.log", "utf8").trim().split("\\n").length === 1;
if (behaviour.breakLock) fs.writeFileSync(".mixos/lock", JSON.stringify({ ...lock, token: "someone-else-0123456789" }));
if (behaviour.exit) process.exit(behaviour.exit);
if (behaviour.hang || (behaviour.hangFirst && first)) setInterval(() => {}, 1000);
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
    assert.deepEqual(result, { items: [], acted: [], cancelled: false, regenerated: null, notes: [] });
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

// ── an update ───────────────────────────────────────────────────────────────

/** The release a pending update puts in place: a changed manifest, and a migration more. */
const ACME_NEW = [
  file("app.json", '{"name":"Acme","egress":["files.example.com"]}\n'),
  file("api/items/route.ts", "export {};\n"),
  file("migrations/0002_tags.sql", "create table tags (id integer primary key);\n"),
];

/** apps/<slug>/ as Register leaves it: ACME and its install record, 1.2.0 at commit a…a. */
function inPlace(slug: string): string {
  const dir = path.join(root, "apps", slug);
  for (const e of ACME) {
    fs.mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, e.path), e.data, { mode: 0o644 });
  }
  fs.writeFileSync(
    path.join(dir, INSTALL_RECORD_FILE),
    serializeInstallRecord(recordFor("app", slug, ACME, { version: "1.2.0", gitTag: "v1.2.0", commitSha: "a".repeat(40) })),
  );
  return dir;
}

/** A pending update of apps/<slug> from 1.2.0 to 1.3.0, as install's update mode leaves one. */
function pendUpdate(slug: string, replaces: Partial<Replaces> = {}, fields: Partial<PendingSidecar> = {}) {
  const dir = inPlace(slug);
  return pend("app", slug, ACME_NEW, {
    record: { version: "1.3.0", gitTag: "v1.3.0" },
    replaces: {
      version: "1.2.0",
      gitTag: "v1.2.0",
      commitSha: "a".repeat(40),
      filesHash: filesHash(ACME),
      folderHash: folderFilesHash(dir),
      localChangesDiscarded: false,
      direction: "newer",
      ...replaces,
    },
    ...fields,
  });
}

const versionIn = (rel: string) => {
  const read = readInstallRecord(path.join(root, rel));
  return read.state === "ok" ? read.record.version : null;
};

describe("Register, an update", () => {
  test("swaps it for the folder in place, which waits in its backup while the generator runs, then goes", async () => {
    const where = pendUpdate("acme");
    const result = await registerPending("app", "acme", options());

    // While the generator ran: 1.3.0 in place, 1.2.0 in the backup.
    const [run, ...more] = runs();
    assert.deepEqual(more, []);
    assert.deepEqual([run.versions.acme, run.backup.acme, run.tokenMatches], ["1.3.0", "1.2.0", true]);
    // After: 1.3.0 in place, with its record, and nothing left behind.
    assert.equal(versionIn("apps/acme"), "1.3.0");
    assert.equal(exists("apps/acme/migrations/0002_tags.sql"), true);
    for (const left of [".mixos/backup/apps/acme", ".mixos/backup/apps/acme.json"]) assert.equal(exists(left), false, left);
    assert.equal(fs.existsSync(where.folder), false);
    assert.equal(fs.existsSync(where.sidecar), false);
    assert.equal(readCheckoutLock(root).exists, false);

    assert.deepEqual(result.update, {
      from: { version: "1.2.0", gitTag: "v1.2.0", commitSha: "a".repeat(40) },
      direction: "newer",
      localChangesDiscarded: false,
      migrationsAdded: ["0002_tags.sql"],
      changes: {
        changed: [".registry.json", "app.json"],
        added: ["migrations/0002_tags.sql"],
        removed: [],
        more: { changed: 0, added: 0, removed: 0 },
        incomplete: false,
      },
    });
    assert.equal(result.handBack.commitMessage.split("\n")[0], "feat(acme): update app acme from 1.2.0 to 1.3.0");
    assert.match(result.handBack.commands, /^git switch -c update-app-acme\n/);

    // Only the register lock and the audit row reached the database, so the
    // app's activation, grants and settings are as they were: the pool refuses
    // any other statement.
    assert.deepEqual([...new Set(lockLog.map((l) => l.what))].sort(), ["release", "renew", "take"]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "app.register");
    assert.deepEqual(audit[0].details.update, {
      from: { version: "1.2.0", gitTag: "v1.2.0", commitSha: "a".repeat(40) },
      direction: "newer",
      localChangesDiscarded: false,
      swapped: true,
      backupDeleted: true,
    });
  });

  test("refuses, moving nothing, when the folder in place isn't what the update was prepared against", async () => {
    const refusedWith = (pattern: RegExp) => (err: unknown) =>
      err instanceof RegisterError && err.code === "folder-changed" && pattern.test(err.message);

    pendUpdate("edited");
    fs.appendFileSync(path.join(root, "apps/edited/api/items/route.ts"), "globalThis.x = 1;\n");
    await assert.rejects(
      registerPending("app", "edited", options()),
      refusedWith(/^\.mixos\/pending\/apps\/edited\/ was not registered: nothing was moved\. apps\/edited has changed since this update was prepared/),
    );

    pendUpdate("reinstalled");
    fs.writeFileSync(
      path.join(root, "apps/reinstalled", INSTALL_RECORD_FILE),
      serializeInstallRecord(recordFor("app", "reinstalled", ACME, { version: "1.2.1", commitSha: "b".repeat(40) })),
    );
    await assert.rejects(
      registerPending("app", "reinstalled", options()),
      refusedWith(/apps\/reinstalled\/\.registry\.json no longer records 1\.2\.0, the release this update replaces/),
    );

    pendUpdate("gone");
    fs.rmSync(path.join(root, "apps/gone"), { recursive: true });
    await assert.rejects(registerPending("app", "gone", options()), refusedWith(/apps\/gone is gone, so there is nothing for this update to replace/));

    pendUpdate("linked");
    fs.symlinkSync("/etc/hosts", path.join(root, "apps/linked/hosts.ts"));
    await assert.rejects(
      registerPending("app", "linked", options()),
      refusedWith(/apps\/linked holds something no files hash covers \(hosts\.ts is a symbolic link, which install never writes\)/),
    );

    // Nothing moved, nothing ran, and each refusal is audited with the releases.
    assert.deepEqual(runs(), []);
    assert.equal(exists(".mixos/backup"), false);
    assert.deepEqual(
      audit.map((r) => [r.action, r.details.reason]),
      ["edited", "reinstalled", "gone", "linked"].map(() => ["app.register.rejected", "folder-changed"]),
    );
    assert.deepEqual(audit[0].details.update, {
      from: { version: "1.2.0", commitSha: "a".repeat(40) },
      to: { version: "1.3.0", commitSha: "c".repeat(40) },
    });
  });

  test("one the generator refuses goes back to pending, the folder it replaced back in place, and the registry is regenerated", async () => {
    const where = pendUpdate("acme");
    behave({ refuse: ["acme"] });
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "rejected-by-registry" &&
      /so 1\.2\.0 was put back in apps\/acme, and 1\.3\.0 waits in \.mixos\/pending\/apps\/acme\/ again\./.test(err.message),
    );
    const [during, after] = runs();
    assert.deepEqual([during.versions.acme, during.backup.acme], ["1.3.0", "1.2.0"]);
    assert.deepEqual([after.versions.acme, after.backup], ["1.2.0", {}]);
    assert.equal(versionIn("apps/acme"), "1.2.0");
    assert.equal(versionIn(where.rel), "1.3.0");
    const read = readSidecar(where.sidecar);
    assert.equal(read.state === "ok" && read.sidecar.register, undefined);
    assert.equal(read.state === "ok" && read.sidecar.replaces?.version, "1.2.0");
    assert.equal(exists(".mixos/backup/apps/acme.json"), false);
  });

  test("stopped (Ctrl-C) while the generator runs, it is put back all the same", async () => {
    const where = pendUpdate("acme");
    behave({ hangFirst: true });
    const controller = new AbortController();
    const registering = registerPending("app", "acme", options({ signal: controller.signal }));
    while (runs().length === 0) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await assert.rejects(registering, (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "stopped" &&
      /^Stopped before it finished\. 1\.2\.0 was put back in apps\/acme, and 1\.3\.0 waits in \.mixos\/pending\/apps\/acme\/ again\./.test(err.message),
    );
    assert.equal(versionIn("apps/acme"), "1.2.0");
    assert.equal(versionIn(where.rel), "1.3.0");
    assert.equal(exists(".mixos/backup/apps/acme"), false);
    assert.equal(readCheckoutLock(root).exists, false);
    // The run that put the registry back wasn't stopped.
    assert.deepEqual(runs().map((r) => r.versions.acme), ["1.3.0", "1.2.0"]);
    assert.equal(audit[0].details.reason, "stopped");
  });

  test("a checkout lock lost while the generator runs leaves the swap as it is, for recovery", async () => {
    const where = pendUpdate("acme");
    behave({ refuse: ["acme"], breakLock: true });
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError && err.code === "lock-lost" && /Run `npm run register -- --recover` to restore 1\.2\.0\./.test(err.message),
    );
    assert.equal(versionIn("apps/acme"), "1.3.0");
    assert.equal(versionIn(".mixos/backup/apps/acme"), "1.2.0");
    const record = readBackupRecord(backupLocation(root, "app", "acme").record);
    assert.equal(record.state === "ok" && record.record.operation, "update");
    const sidecar = readSidecar(where.sidecar);
    assert.equal(sidecar.state === "ok" && sidecar.sidecar.register?.pid, process.pid);
  });
});

// ── recovering an update ────────────────────────────────────────────────────

describe("recovering an update that stopped midway", () => {
  const gone = () => ({ token: "an-update-that-stopped-0001", pid: deadPid(), hostname: os.hostname(), startedAt: new Date().toISOString() });

  /**
   * What an update killed partway through its swap leaves: `moved` says how
   * far it got. "nothing": the records written, nothing moved. "aside": the
   * folder in its backup, the update still in pending. "swapped": the update
   * in place and the folder in its backup, as while the generator ran.
   */
  function killed(slug: string, moved: "nothing" | "aside" | "swapped", { accepted = false } = {}) {
    const where = pendUpdate(slug);
    const holder = gone();
    const sidecar = readSidecar(where.sidecar);
    const to = readInstallRecord(where.folder);
    assert.ok(sidecar.state === "ok" && sidecar.sidecar.replaces && to.state === "ok");
    writeSidecar(where.sidecar, { ...sidecar.sidecar, register: holder });
    const backup = backupLocation(root, "app", slug);
    writeBackupRecord(backup.record, {
      ...updateRecordFor("app", slug, holder.token, sidecar.sidecar.replaces, to.record),
      pid: holder.pid,
      ...(accepted ? { accepted: true as const } : {}),
    });
    if (moved !== "nothing") {
      fs.mkdirSync(path.dirname(backup.folder), { recursive: true });
      fs.renameSync(path.join(root, "apps", slug), backup.folder);
    }
    if (moved === "swapped") fs.renameSync(where.folder, path.join(root, "apps", slug));
    return { where, backup };
  }

  /** Recovery that answers `pick` when asked which way, and yes after. */
  const recoverWith = (pick: "restore-update" | "keep-update" | null) => {
    const asked: RecoveryItem[] = [];
    return {
      asked,
      run: () =>
        recoverCheckout({
          ...options(),
          choose: async (item) => {
            asked.push(item);
            return pick;
          },
          confirm: async () => true,
        }),
    };
  };

  test("an update with its release in place offers both ways, and covers its pending install too", () => {
    killed("acme", "swapped");
    const items = planRecovery(root);
    assert.deepEqual(items.map((i) => [i.action, i.path]), [["restore-update", ".mixos/backup/apps/acme"]]);
    const [item] = items;
    assert.match(
      item.found,
      /^An update of acme from 1\.2\.0 to 1\.3\.0 \(pid \d+ on this machine, started .+\) stopped with 1\.3\.0 in apps\/acme and 1\.2\.0 in \.mixos\/backup\/apps\/acme\/, before the registry generator accepted 1\.3\.0\.$/,
    );
    assert.deepEqual(item.choices?.map((c) => [c.action, c.label]), [
      ["restore-update", "restore 1.2.0"],
      ["keep-update", "keep 1.3.0"],
    ]);
  });

  test("restore: the update goes back to pending and the release it replaced back in place", async () => {
    const { where } = killed("acme", "swapped");
    const { asked, run } = recoverWith("restore-update");
    const result = await run();
    assert.equal(asked.length, 1);
    assert.deepEqual(result.acted.map((i) => i.action), ["restore-update"]);
    assert.equal(versionIn("apps/acme"), "1.2.0");
    assert.equal(versionIn(where.rel), "1.3.0");
    const sidecar = readSidecar(where.sidecar);
    assert.equal(sidecar.state === "ok" && sidecar.sidecar.register, undefined);
    assert.equal(exists(".mixos/backup/apps/acme"), false);
    assert.equal(exists(".mixos/backup/apps/acme.json"), false);
    assert.equal(result.regenerated?.ok, true);
    assert.deepEqual(runs().at(-1)?.versions, { acme: "1.2.0" });
    assert.deepEqual(audit.map((r) => [r.action, r.details.action]), [["app.update.recover", "restore-update"]]);
    // And it can be registered again.
    await registerPending("app", "acme", options());
    assert.equal(versionIn("apps/acme"), "1.3.0");
  });

  test("keep: the generator runs with the update in place, and once it accepts it the backup goes", async () => {
    const { where } = killed("acme", "swapped");
    const result = await recoverWith("keep-update").run();
    assert.deepEqual(result.acted.map((i) => i.action), ["keep-update"]);
    assert.deepEqual(result.notes, []);
    assert.equal(versionIn("apps/acme"), "1.3.0");
    for (const left of [where.sidecar, where.folder]) assert.equal(fs.existsSync(left), false, left);
    assert.equal(exists(".mixos/backup/apps/acme"), false);
    assert.equal(exists(".mixos/backup/apps/acme.json"), false);
    // The run that accepted it is the only one.
    assert.deepEqual(runs().map((r) => [r.versions.acme, r.backup.acme]), [["1.3.0", "1.2.0"]]);
    assert.equal(result.regenerated, null);
    assert.deepEqual(audit.map((r) => [r.action, r.details.action]), [["app.update.recover", "keep-update"]]);
  });

  test("keep, and the generator refuses it: the release it replaced is restored instead, and said", async () => {
    const { where } = killed("acme", "swapped");
    behave({ refuse: ["acme"] });
    const result = await recoverWith("keep-update").run();
    assert.deepEqual(result.acted.map((i) => i.action), ["restore-update"]);
    assert.match(result.notes.join("\n"), /didn't accept what \.mixos\/backup\/apps\/acme replaced, so recovery restored the backup instead/);
    assert.equal(versionIn("apps/acme"), "1.2.0");
    assert.equal(versionIn(where.rel), "1.3.0");
    assert.equal(result.regenerated?.ok, true);
  });

  test("neither chosen: it is left as it is, and nothing is asked after", async () => {
    killed("acme", "swapped");
    let confirmed = false;
    const result = await recoverCheckout({ ...options(), choose: async () => null, confirm: async () => (confirmed = true) });
    assert.equal(confirmed, false);
    assert.equal(result.cancelled, true);
    assert.equal(versionIn("apps/acme"), "1.3.0");
    assert.equal(exists(".mixos/backup/apps/acme.json"), true);
  });

  test("one the generator accepted is finished: the backup and the pending sidecar go, with nothing to choose", async () => {
    const { where } = killed("acme", "swapped", { accepted: true });
    const { asked, run } = recoverWith(null);
    const result = await run();
    assert.equal(asked.length, 0);
    assert.deepEqual(result.acted.map((i) => i.action), ["finish-update"]);
    assert.equal(versionIn("apps/acme"), "1.3.0");
    assert.equal(fs.existsSync(where.sidecar), false);
    assert.equal(exists(".mixos/backup/apps/acme"), false);
    assert.equal(result.regenerated, null);
  });

  test("one stopped before anything moved has its records cleared, and the update stays in pending", async () => {
    const { where } = killed("acme", "nothing");
    const result = await recoverWith(null).run();
    assert.deepEqual(result.acted.map((i) => i.action), ["clear-update-record"]);
    assert.equal(versionIn("apps/acme"), "1.2.0");
    assert.equal(versionIn(where.rel), "1.3.0");
    const sidecar = readSidecar(where.sidecar);
    assert.equal(sidecar.state === "ok" && sidecar.sidecar.register, undefined);
    assert.equal(exists(".mixos/backup/apps/acme.json"), false);
  });

  test("one stopped between the two renames is put back, with nothing to choose", async () => {
    const { where } = killed("acme", "aside");
    const items = planRecovery(root);
    assert.deepEqual(items.map((i) => [i.action, i.choices]), [["restore-update", undefined]]);
    const result = await recoverWith(null).run();
    assert.deepEqual(result.acted.map((i) => i.action), ["restore-update"]);
    assert.equal(versionIn("apps/acme"), "1.2.0");
    assert.equal(versionIn(where.rel), "1.3.0");
  });

  test("a stopped registration of an update that never wrote its backup record has its record cleared", async () => {
    const where = pendUpdate("acme", {}, { register: gone() });
    assert.deepEqual(planRecovery(root).map((i) => i.action), ["clear-record"]);
    await recoverWith(null).run();
    assert.equal(versionIn("apps/acme"), "1.2.0");
    const sidecar = readSidecar(where.sidecar);
    assert.equal(sidecar.state === "ok" && sidecar.sidecar.register, undefined);
  });

  test("left alone while the process named in its record still holds the checkout lock", async () => {
    const holder = tryAcquireCheckoutLock(root, "npm run register");
    try {
      const where = pendUpdate("acme");
      const backup = backupLocation(root, "app", "acme");
      const replaces = readSidecar(where.sidecar);
      const to = readInstallRecord(where.folder);
      assert.ok(replaces.state === "ok" && replaces.sidecar.replaces && to.state === "ok");
      writeBackupRecord(backup.record, updateRecordFor("app", "acme", holder.token, replaces.sidecar.replaces, to.record));
      const [item] = planRecovery(root);
      assert.equal(item.action, "clear-update-record");
      assert.match(item.blocked ?? "", /^The update that recorded it, pid \d+ on this machine, is still running\./);
    } finally {
      holder.release();
    }
  });

  test("Register and removal refuse the name until it is recovered, naming the update", async () => {
    killed("acme", "swapped");
    // The backup's record says which releases are where; the pending sidecar's
    // registration record, which the same crash left, only that it stopped.
    await assert.rejects(registerPending("app", "acme", options()), (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "interrupted" &&
      /left \.mixos\/backup\/apps\/acme\. Run `npm run register -- --recover` to restore 1\.2\.0 or keep 1\.3\.0/.test(err.message),
    );
    // The refusal's row names both releases, from the backup's record: the
    // pending folder, which held the release it goes to, is in place now.
    assert.equal(audit.at(-1)?.details.reason, "interrupted");
    assert.deepEqual(audit.at(-1)?.details.update, {
      from: { version: "1.2.0", commitSha: "a".repeat(40) },
      to: { version: "1.3.0", commitSha: "c".repeat(40) },
    });
    await assert.rejects(planRemoval("app", "acme", root), (err: unknown) =>
      err instanceof RemoveError &&
      err.code === "interrupted" &&
      err.message ===
        "An update of acme from 1.2.0 to 1.3.0 stopped before it finished, and left .mixos/backup/apps/acme. Run " +
          "`npm run register -- --recover` to restore 1.2.0 or keep 1.3.0, then try again.",
    );
  });
});
