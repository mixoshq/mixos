/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Removing an extension's code, each in a checkout of its own, against a
 * stand-in for the registry generator and a stubbed database pool, and
 * recovering from a removal that stopped midway.
 *
 * The stand-in checks the lock token it is handed against `.mixos/lock`,
 * records what it saw (the extension folders, and what waits in
 * `.mixos/backup/`), and "registers" every folder in apps/, connectors/ and
 * themes/ unless a test tells it otherwise, by writing the three generated
 * registry modules removal reads. The pool answers the register lock's
 * statements and the applied theme, and keeps the audit rows.
 * remove.integration.test.ts runs a removal against a real Postgres.
 */

import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliActorName } from "../apps/audit-actors";
import { readCheckoutLock, tryAcquireCheckoutLock } from "../platform/checkout-lock";
import { backupLocation, readBackupRecord, writeBackupRecord, type RemovalRecord } from "./backup";
import { ciSkipMarker } from "./hand-back";
import { filesHash, hashFileTree } from "./content-hash";
import { INSTALL_RECORD_FILE, serializeInstallRecord, type InstallRecord } from "./install-record";
import { pendingLocation, writeSidecar, type PendingKind } from "./pending";
import { planRecovery, recoverCheckout, registerPending, describeRegisterFailure } from "./register";
import { RemoveError, describeRemoveFailure, planRemoval, removeExtension } from "./remove";
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
let lockLog: { what: "take" | "renew" | "release"; at: number }[] = [];
let rowLockTaken = false;
/** What `platform_settings` holds under `theme`: a slug, null for no row, or "fail" to throw. */
let storedTheme: string | null | "fail" = null;

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
    if (text.startsWith("select value from public.platform_settings where key = 'theme'")) {
      if (storedTheme === "fail") throw new Error("database unreachable");
      return storedTheme === null ? [] : [{ value: storedTheme }];
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-remove-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * The stand-in generator. `behaviour.json` in the checkout steers it:
 * `exitFirst` (a code its first run stops with), `exit` (every run), `hangFirst`
 * (its first run never finishes), `alsoList` (names to keep listing per folder,
 * as if the folder were still there), `breakLock` (replace the lock file).
 */
const STAND_IN = path.join(tmp, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const args = process.argv.slice(2);
const token = args[args.indexOf("--lock-token") + 1];
const lock = JSON.parse(fs.readFileSync(".mixos/lock", "utf8"));
const behaviour = fs.existsSync("behaviour.json") ? JSON.parse(fs.readFileSync("behaviour.json", "utf8")) : {};
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".") && !n.startsWith("_") && !n.endsWith(".json")) : []);
fs.appendFileSync("runs.log", JSON.stringify({
  at: Date.now(),
  tokenMatches: lock.token === token && lock.pid !== process.pid,
  apps: list("apps"),
  connectors: list("connectors"),
  themes: list("themes"),
  backup: { apps: list(".mixos/backup/apps"), connectors: list(".mixos/backup/connectors"), themes: list(".mixos/backup/themes") },
  env: Object.keys(process.env).filter((k) => !k.startsWith("__CF_")).sort(),
}) + "\\n");
const first = fs.readFileSync("runs.log", "utf8").trim().split("\\n").length === 1;
if (behaviour.breakLock) fs.writeFileSync(".mixos/lock", JSON.stringify({ ...lock, token: "someone-else-0123456789" }));
if (behaviour.exit) process.exit(behaviour.exit);
if (behaviour.exitFirst && first) process.exit(behaviour.exitFirst);
if (behaviour.hangFirst && first) setInterval(() => {}, 1000);
else {
  const also = behaviour.alsoList ?? {};
  const keep = (dir) => [...list(dir), ...(also[dir] ?? [])];
  fs.mkdirSync("src/generated", { recursive: true });
  fs.writeFileSync("src/generated/app-registry.ts", "export const appRegistry = " + JSON.stringify(keep("apps").map((slug) => ({ slug })), null, 2) + ";\\n");
  fs.writeFileSync("src/generated/connector-registry.ts", "export const connectorRegistry = " + JSON.stringify(keep("connectors").map((name) => ({ name })), null, 2) + ";\\n");
  fs.writeFileSync("src/generated/theme-registry.ts", "export const themeRegistry = " + JSON.stringify(keep("themes").map((slug) => ({ slug })), null, 2) + ";\\n");
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
  storedTheme = null;
});
afterEach(() => {
  delete process.env.VERCEL;
});

const ACTOR = { id: null, email: cliActorName("tester", "test-host") };
const options = (extra: Partial<Parameters<typeof removeExtension>[2]> = {}) => ({
  actor: ACTOR,
  via: "cli" as const,
  root,
  generator: STAND_IN,
  notice: () => {},
  ...extra,
});

const write = (rel: string, data: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};
const exists = (rel: string) => fs.existsSync(path.join(root, rel));
const behave = (b: Record<string, unknown>) => fs.writeFileSync(path.join(root, "behaviour.json"), JSON.stringify(b));
const runs = () =>
  exists("runs.log")
    ? fs.readFileSync(path.join(root, "runs.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

/** An app in apps/, its manifest holding `fields`. */
const app = (slug: string, fields: Record<string, unknown> = {}) => {
  write(`apps/${slug}/app.json`, JSON.stringify({ name: slug.toUpperCase(), ...fields }));
  write(`apps/${slug}/api/items/route.ts`, "export {};\n");
};
const connector = (name: string) => write(`connectors/${name}/connector.json`, JSON.stringify({ name, displayName: `The ${name}` }));
const theme = (slug: string, name = slug) => {
  write(`themes/${slug}/theme.json`, JSON.stringify({ name }));
  write(`themes/${slug}/theme.css`, ":root {}\n");
};

const file = (p: string, data: string): TarEntry => ({ path: p, mode: 0o644, data: Buffer.from(data) });
const ACME = [file("app.json", '{"name":"Acme"}\n'), file("api/items/route.ts", "export {};\n")];

function recordFor(kind: PendingKind | "theme", slug: string, entries: TarEntry[]): InstallRecord {
  return {
    source: "https://mixos.org",
    kind,
    slug,
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "c".repeat(40),
    contentHash: hashFileTree(entries),
    filesHash: filesHash(entries),
    repository: { owner: "acme", name: "mixos-apps", subpath: null },
    requiresMixOS: null,
  };
}

/** A pending install, as install leaves one. */
function pend(kind: PendingKind, slug: string, entries: TarEntry[] = ACME) {
  const where = pendingLocation(root, kind, slug);
  fs.mkdirSync(where.folder, { recursive: true });
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(where.folder, e.path)), { recursive: true });
    fs.writeFileSync(path.join(where.folder, e.path), e.data);
  }
  fs.writeFileSync(path.join(where.folder, INSTALL_RECORD_FILE), serializeInstallRecord(recordFor(kind, slug, entries)));
  writeSidecar(where.sidecar, {
    kind,
    slug,
    yankedAccepted: false,
    installedAt: "2026-10-11T09:00:00.000Z",
    installedBy: "admin@example.com",
    check: { verdict: "accepted", deferred: [] },
  });
  return where;
}

const failedWith = (code: string) => (err: unknown) => describeRemoveFailure(err).code === code;

// ── removing ────────────────────────────────────────────────────────────────

describe("removing an extension's code", () => {
  test("moves the folder out of the build while the generator runs, then deletes it, and audits it", async () => {
    app("acme");
    app("other");
    const result = await removeExtension("app", "acme", options());

    assert.equal(exists("apps/acme"), false);
    assert.equal(exists(".mixos/backup/apps/acme"), false);
    assert.equal(exists(".mixos/backup/apps/acme.json"), false);
    assert.equal(exists("apps/other/app.json"), true);
    // One run, under the removal's own lock, with the folder in backup and out of apps/.
    const [run, ...more] = runs();
    assert.deepEqual(more, []);
    assert.equal(run.tokenMatches, true);
    assert.deepEqual(run.apps, ["other"]);
    assert.deepEqual(run.backup.apps, ["acme"]);
    assert.deepEqual(run.env.filter((k: string) => k !== "PATH" && k !== "TMPDIR"), []);
    // No lock left behind, and the register lock held throughout.
    assert.equal(readCheckoutLock(root).exists, false);
    const taken = lockLog.find((l) => l.what === "take")!;
    const released = lockLog.find((l) => l.what === "release")!;
    assert.ok(taken.at <= run.at && run.at <= released.at);
    assert.ok(lockLog.filter((l) => l.what === "renew").length >= 2);

    assert.equal(result.path, "apps/acme");
    assert.equal(result.name, "ACME");
    assert.equal(result.installed, null);
    assert.equal(result.fileCount, 2);
    assert.match(result.nextStep, /^Removed apps\/acme from this checkout, and the registry no longer has it\. Its data stays/);
    assert.match(result.nextStep, /each instance keeps the app's data until an admin deletes it there\.$/);

    assert.equal(audit.length, 1);
    const [row] = audit;
    assert.equal(row.action, "app.remove");
    assert.equal(row.actor_id, null);
    assert.equal(row.actor_email, "cli:tester@test-host");
    assert.equal(row.target_type, "app");
    assert.equal(row.target_id, "acme");
    assert.deepEqual(row.details, { via: "cli", path: "apps/acme", fileCount: 2, byteCount: result.byteCount, local: true });
  });

  test("hands back the commit that deletes the folder, built from identifiers, and the commands", async () => {
    app("acme");
    const { handBack } = await removeExtension("app", "acme", options());
    assert.equal(handBack.folder, "apps/acme");
    assert.deepEqual(handBack.files.map((f) => f.path), ["api/items/route.ts", "app.json"]);
    assert.equal(handBack.installedFrom, null);
    assert.equal(handBack.branch, "remove-app-acme");
    assert.equal(handBack.commitMessage.split("\n")[0], "feat(acme): remove app acme");
    assert.doesNotMatch(handBack.commitMessage, /Registry-/);
    assert.match(handBack.commands, /^git switch -c remove-app-acme\ngit rm -r apps\/acme\ngit commit -F - -- apps\/acme <<'MSG'\n/);
    assert.match(handBack.commands, /\nMSG\ngit push -u origin HEAD$/);
  });

  test("an extension installed from a Registry takes its install record with it, and the commit names the release", async () => {
    app("acme");
    write("apps/acme/.registry.json", serializeInstallRecord(recordFor("app", "acme", ACME)));
    const plan = await planRemoval("app", "acme", root);
    assert.deepEqual(plan.installed, { source: "https://mixos.org", version: "1.2.0" });

    const result = await removeExtension("app", "acme", options());
    assert.equal(exists("apps/acme"), false);
    assert.ok(result.handBack.files.some((f) => f.path === INSTALL_RECORD_FILE));
    assert.equal(result.handBack.installedFrom, "mixos.org");
    const lines = result.handBack.commitMessage.split("\n");
    assert.equal(lines[0], "feat(acme): remove app acme 1.2.0 from mixos.org");
    assert.deepEqual(lines.slice(-2), ["Registry-Source: https://mixos.org", "Registry-Version: 1.2.0"]);
    assert.match(result.handBack.commitMessage, /Its install record, apps\/acme\/\.registry\.json, goes with it\./);
    assert.equal(ciSkipMarker(result.handBack.commitMessage), null);
    assert.equal(audit[0].details.source, "https://mixos.org");
    assert.equal(audit[0].details.version, "1.2.0");
  });

  test("a record that isn't its own is left out of the message, and deleted with the folder", async () => {
    app("acme");
    write("apps/acme/.registry.json", serializeInstallRecord(recordFor("app", "other", ACME)));
    const result = await removeExtension("app", "acme", options());
    assert.equal(result.installed, null);
    assert.equal(result.handBack.commitMessage.split("\n")[0], "feat(acme): remove app acme");
  });

  test("removes a local app whose slug has an underscore, and a connector and a theme", async () => {
    app("my_app");
    connector("probe");
    theme("aurora");
    theme("dusk");
    await removeExtension("app", "my_app", options());
    await removeExtension("connector", "probe", options());
    await removeExtension("theme", "dusk", options());
    assert.deepEqual(
      [exists("apps/my_app"), exists("connectors/probe"), exists("themes/dusk"), exists("themes/aurora")],
      [false, false, false, true],
    );
    assert.deepEqual(audit.map((r) => r.action), ["app.remove", "connector.remove", "theme.remove"]);
    const [, connectorRun, themeRun] = runs();
    assert.deepEqual(connectorRun.backup.connectors, ["probe"]);
    assert.deepEqual(themeRun.backup.themes, ["dusk"]);
  });

  test("discards a pending install of the same name once the removal is accepted", async () => {
    app("acme");
    const where = pend("app", "acme");
    const plan = await planRemoval("app", "acme", root);
    assert.equal(plan.pending, ".mixos/pending/apps/acme");
    const result = await removeExtension("app", "acme", options());
    assert.equal(result.discardedPending, ".mixos/pending/apps/acme");
    assert.equal(fs.existsSync(where.folder), false);
    assert.equal(fs.existsSync(where.sidecar), false);
    assert.equal(audit[0].details.discardedPending, ".mixos/pending/apps/acme");
  });
});

describe("what refuses a removal", () => {
  test("a connector an app requires: nothing moves, nothing runs, and the refusal is audited", async () => {
    connector("probe");
    app("mailer", { name: "Mailer", connectors: ["probe"] });
    const plan = await planRemoval("connector", "probe", root);
    assert.deepEqual(plan.blockers.map((b) => b.code), ["required-by"]);
    assert.deepEqual(plan.blockers[0].apps, [{ slug: "mailer", name: "Mailer" }]);
    assert.match(plan.blockers[0].message, /^Required by Mailer \(apps\/mailer\), which can't work without it\./);

    await assert.rejects(removeExtension("connector", "probe", options()), (err: unknown) =>
      err instanceof RemoveError &&
      err.code === "depended-on" &&
      /^The probe can't be removed\. Required by Mailer/.test(err.message) &&
      /Nothing was changed\.$/.test(err.message),
    );
    assert.equal(exists("connectors/probe/connector.json"), true);
    assert.equal(exists(".mixos/backup"), false);
    assert.deepEqual(runs(), []);
    assert.equal(audit[0].action, "connector.remove.rejected");
    assert.equal(audit[0].details.reason, "depended-on");
    assert.equal(audit[0].details.via, "cli");
  });

  test("an app whose services another uses, or whose hooks another listens to", async () => {
    app("acme");
    app("notes", { name: "Notes", consumes: [{ app: "acme", service: "items" }] });
    app("board", { name: "Board", listensTo: [{ app: "acme", hook: "updated" }] });
    // Its own use of itself doesn't count.
    app("self", { consumes: [{ app: "self", service: "x" }] });
    const plan = await planRemoval("app", "acme", root);
    assert.deepEqual(plan.blockers.map((b) => [b.code, b.apps.map((a) => a.slug)]), [
      ["consumed-by", ["notes"]],
      ["listened-to-by", ["board"]],
    ]);
    assert.match(plan.blockers[0].message, /^Notes \(apps\/notes\) uses its services, and the build fails without it\./);
    assert.deepEqual((await planRemoval("app", "self", root)).blockers, []);

    await assert.rejects(removeExtension("app", "acme", options()), failedWith("depended-on"));
    assert.equal(exists("apps/acme/app.json"), true);
    assert.deepEqual(runs(), []);
  });

  test("an app the build skips still counts: the next build reads the same manifest", async () => {
    connector("probe");
    // No route, an odd manifest: whatever the generator makes of it, it names the connector.
    write("apps/broken/app.json", JSON.stringify({ connectors: ["probe"], widgets: "not a list" }));
    const plan = await planRemoval("connector", "probe", root);
    assert.deepEqual(plan.blockers[0].apps, [{ slug: "broken", name: "broken" }]);
    // Templates and dot folders are not apps.
    write("apps/_template/app.json", JSON.stringify({ connectors: ["other"] }));
    write("apps/.old-x/app.json", JSON.stringify({ connectors: ["other"] }));
    connector("other");
    assert.deepEqual((await planRemoval("connector", "other", root)).blockers, []);
  });

  test("the last theme", async () => {
    theme("aurora");
    const plan = await planRemoval("theme", "aurora", root);
    assert.deepEqual(plan.blockers.map((b) => b.code), ["last-theme"]);
    await assert.rejects(removeExtension("theme", "aurora", options()), (err: unknown) =>
      err instanceof RemoveError && err.code === "last-theme" && /the build needs one/.test(err.message),
    );
    assert.equal(exists("themes/aurora/theme.json"), true);
    // A folder with no theme.json isn't a theme, so it doesn't save the last one.
    fs.mkdirSync(path.join(root, "themes", "draft"));
    assert.deepEqual((await planRemoval("theme", "aurora", root)).blockers.map((b) => b.code), ["last-theme"]);
  });

  test("on a built deployment, before any lock", async () => {
    app("acme");
    process.env.VERCEL = "1";
    await assert.rejects(removeExtension("app", "acme", options()), (err: unknown) =>
      err instanceof RemoveError &&
      err.code === "unsupported-environment" &&
      err.message === "This deployment runs a build. Remove the extension in a checkout of your repository, commit the deletion, and deploy.",
    );
    assert.deepEqual(lockLog, []);
    assert.equal(exists("apps/acme/app.json"), true);
    assert.equal(audit[0].details.reason, "unsupported-environment");
  });

  test("while another holds a lock", async () => {
    app("acme");
    rowLockTaken = true;
    await assert.rejects(removeExtension("app", "acme", options()), failedWith("locked"));
    rowLockTaken = false;
    const held = tryAcquireCheckoutLock(root, "npm run register");
    try {
      await assert.rejects(removeExtension("app", "acme", options()), (err: unknown) =>
        describeRemoveFailure(err).code === "locked" && /npm run register/.test(describeRemoveFailure(err).message),
      );
    } finally {
      held.release();
    }
    assert.equal(exists("apps/acme/app.json"), true);
    assert.deepEqual(runs(), []);
  });

  test("what isn't there, isn't an extension, or isn't a name", async () => {
    await assert.rejects(planRemoval("app", "ghost", root), (err: unknown) =>
      err instanceof RemoveError && err.code === "not-installed" && /^Nothing named ghost is in apps\/\.$/.test(err.message),
    );
    fs.mkdirSync(path.join(root, "apps", "plans-only", "plans"), { recursive: true });
    await assert.rejects(planRemoval("app", "plans-only", root), (err: unknown) =>
      err instanceof RemoveError && /has no app\.json/.test(err.message),
    );
    for (const name of ["_template", ".hidden", "../etc", "a/b", "Acme", ""]) {
      await assert.rejects(planRemoval("app", name, root), failedWith("not-installed"), name);
    }
    // Only a pending one: discard it instead.
    pend("app", "waiting");
    await assert.rejects(planRemoval("app", "waiting", root), (err: unknown) =>
      err instanceof RemoveError && /npm run register -- app\/waiting --discard/.test(err.message),
    );
  });

  test("a registration of the same name that stopped midway", async () => {
    app("acme");
    const where = pend("app", "acme");
    writeSidecar(where.sidecar, {
      kind: "app",
      slug: "acme",
      yankedAccepted: false,
      installedAt: "2026-10-11T09:00:00.000Z",
      installedBy: "admin@example.com",
      check: { verdict: "accepted", deferred: [] },
      register: { token: "t".repeat(36), pid: 1, hostname: os.hostname(), startedAt: "2026-10-11T09:01:00.000Z" },
    });
    await assert.rejects(planRemoval("app", "acme", root), (err: unknown) =>
      err instanceof RemoveError && err.code === "interrupted" && /npm run register -- --recover/.test(err.message),
    );
  });
});

describe("warnings", () => {
  test("an app that uses the connector optionally is named, and the removal goes ahead", async () => {
    connector("probe");
    app("digest", { name: "Digest", optionalConnectors: ["probe"] });
    // Declared both ways, it requires it.
    const plan = await planRemoval("connector", "probe", root);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.warnings.map((w) => [w.code, w.apps.map((a) => a.slug)]), [["optional-for", ["digest"]]]);
    assert.match(plan.warnings[0].message, /^Optional for Digest \(apps\/digest\): the parts that use it stop working/);
    const result = await removeExtension("connector", "probe", options());
    assert.equal(result.warnings.length, 1);
    assert.deepEqual(audit[0].details.optionalFor, ["digest"]);

    connector("again");
    app("both", { connectors: ["again"], optionalConnectors: ["again"] });
    const both = await planRemoval("connector", "again", root);
    assert.deepEqual([both.blockers.map((b) => b.code), both.warnings], [["required-by"], []]);
  });

  test("the theme this checkout's database applies, naming the one pages use next", async () => {
    theme("aurora", "Aurora");
    theme("dusk", "Dusk");
    storedTheme = "dusk";
    const plan = await planRemoval("theme", "dusk", root);
    assert.deepEqual(plan.warnings.map((w) => w.code), ["applied-theme"]);
    assert.match(plan.warnings[0].message, /It is the applied theme in this checkout's database, so pages here use Aurora once it's gone/);
    assert.deepEqual((await planRemoval("theme", "aurora", root)).warnings, []);
    await removeExtension("theme", "dusk", options());
    assert.equal(audit[0].details.appliedTheme, true);
  });

  test("with no theme applied, the first by name is the one in use", async () => {
    theme("aurora", "Aurora");
    theme("dusk", "Dusk");
    storedTheme = null;
    const first = await planRemoval("theme", "aurora", root);
    assert.match(first.warnings[0]?.message ?? "", /No theme is applied in this checkout's database, so pages here use the first theme by name, which is this one\. They use Dusk/);
    assert.deepEqual((await planRemoval("theme", "dusk", root)).warnings, []);
    // A stored theme that is no longer installed counts as none.
    storedTheme = "gone";
    assert.equal((await planRemoval("theme", "aurora", root)).warnings.length, 1);
    // A database that can't be asked warns about nothing.
    storedTheme = "fail";
    assert.deepEqual((await planRemoval("theme", "aurora", root)).warnings, []);
  });
});

describe("a removal the generator doesn't accept", () => {
  test("is put back, its record cleared, and the registry regenerated", async () => {
    app("acme");
    behave({ exitFirst: 3 });
    await assert.rejects(removeExtension("app", "acme", options()), (err: unknown) =>
      err instanceof RemoveError &&
      err.code === "generator-failed" &&
      /^The registry generator failed without apps\/acme, so it was put back\./.test(err.message) &&
      !/failed too/.test(err.message),
    );
    assert.equal(exists("apps/acme/app.json"), true);
    assert.equal(exists(".mixos/backup/apps/acme"), false);
    assert.equal(exists(".mixos/backup/apps/acme.json"), false);
    // The removal's run, without it, then the one that restored the registry, with it.
    const [first, second] = runs();
    assert.deepEqual([first.apps, second.apps], [[], ["acme"]]);
    assert.equal(audit[0].action, "app.remove.rejected");
    assert.equal(audit[0].details.reason, "generator-failed");
    assert.equal(audit[0].details.message, "The registry generator failed without apps/acme, so it was put back. The output below says why.");
  });

  test("says so when regenerating afterwards fails too", async () => {
    app("acme");
    behave({ exit: 3 });
    await assert.rejects(removeExtension("app", "acme", options()), (err: unknown) =>
      err instanceof RemoveError && /Regenerating the registry afterwards failed too/.test(err.message),
    );
    assert.equal(exists("apps/acme/app.json"), true);
  });

  test("a registry that still lists it is a failure too", async () => {
    app("acme");
    behave({ alsoList: { apps: ["acme"] } });
    await assert.rejects(removeExtension("app", "acme", options()), (err: unknown) =>
      err instanceof RemoveError && /^The registry still lists acme after the generator ran without its folder/.test(err.message),
    );
    assert.equal(exists("apps/acme/app.json"), true);
  });

  test("keeps a pending install of the same name", async () => {
    app("acme");
    const where = pend("app", "acme");
    behave({ exitFirst: 3 });
    await assert.rejects(removeExtension("app", "acme", options()), failedWith("generator-failed"));
    assert.equal(fs.existsSync(where.folder), true);
    assert.equal(fs.existsSync(where.sidecar), true);
  });

  test("stopped by Ctrl-C while the generator runs, it is put back all the same", async () => {
    app("acme");
    behave({ hangFirst: true });
    const controller = new AbortController();
    const removing = removeExtension("app", "acme", options({ signal: controller.signal }));
    while (runs().length === 0) await new Promise((r) => setTimeout(r, 20));
    assert.equal(exists(".mixos/backup/apps/acme/app.json"), true);
    controller.abort();
    await assert.rejects(removing, (err: unknown) =>
      err instanceof RemoveError && err.code === "stopped" && /apps\/acme was put back\./.test(err.message),
    );
    assert.equal(exists("apps/acme/app.json"), true);
    assert.equal(exists(".mixos/backup/apps/acme.json"), false);
    // The run that restored the registry wasn't stopped.
    assert.equal(runs().length, 2);
    assert.equal(audit[0].details.reason, "stopped");
  });

  test("a removal that loses its lock stops where it is, and recovery puts it back", async () => {
    app("acme");
    // The lock goes while the generator runs, so the removal can't record
    // that the generator accepted it, nor delete the backup.
    behave({ breakLock: true });
    await assert.rejects(removeExtension("app", "acme", options()), (err: unknown) =>
      err instanceof RemoveError &&
      err.code === "lock-lost" &&
      /The registry no longer has acme, but apps\/acme waits in \.mixos\/backup\/apps\/acme\/\. Run `npm run remove -- --recover` to put it back, then remove it again\.$/.test(
        err.message,
      ),
    );
    // Left as it was when the lock went: the folder in backup, with its record.
    assert.equal(exists("apps/acme"), false);
    assert.equal(exists(".mixos/backup/apps/acme/app.json"), true);
    const read = readBackupRecord(backupLocation(root, "app", "acme").record);
    assert.equal(read.state === "ok" && read.record.accepted, undefined);
    // Removal, Register and install refuse the name until recovery has dealt with it.
    await assert.rejects(planRemoval("app", "acme", root), failedWith("interrupted"));

    // As `--break-lock` would, once a person has checked nothing holds it.
    fs.rmSync(path.join(root, ".mixos", "lock"));
    fs.rmSync(path.join(root, "behaviour.json"));
    const result = await recoverCheckout({ ...options(), confirm: async () => true });
    assert.deepEqual(result.acted.map((i) => [i.action, i.path]), [["restore-backup", ".mixos/backup/apps/acme"]]);
    assert.equal(result.regenerated?.ok, true);
    assert.equal(exists("apps/acme/app.json"), true);
    assert.equal(exists(".mixos/backup/apps/acme"), false);
    assert.equal(exists(".mixos/backup/apps/acme.json"), false);
    const recovered = audit.find((r) => r.action === "app.remove.recover")!;
    assert.deepEqual(recovered.details, { via: "cli", action: "restore-backup", path: ".mixos/backup/apps/acme" });
  });
});

// ── recovery ────────────────────────────────────────────────────────────────

describe("recovering a removal that stopped midway", () => {
  /** A removal's record, as it writes one before the folder moves. */
  const recordOf = (slug: string, fields: Partial<RemovalRecord> = {}): RemovalRecord => ({
    operation: "remove",
    kind: "app",
    slug,
    token: "a-removal-that-stopped-0001",
    pid: 999999,
    hostname: os.hostname(),
    startedAt: "2026-10-11T09:00:00.000Z",
    ...fields,
  });
  /** What a removal killed after it moved the folder leaves. */
  function killedAfterMove(slug: string, fields: Partial<RemovalRecord> = {}) {
    app(slug);
    const where = backupLocation(root, "app", slug);
    writeBackupRecord(where.record, recordOf(slug, fields));
    fs.mkdirSync(path.dirname(where.folder), { recursive: true });
    fs.renameSync(path.join(root, "apps", slug), where.folder);
    return where;
  }

  test("a folder never accepted out of the build is put back, and the registry regenerated", async () => {
    killedAfterMove("acme");
    const [item] = planRecovery(root);
    assert.equal(item.action, "restore-backup");
    assert.equal(item.blocked, null);
    assert.match(item.found, /^A removal of acme \(pid 999999 on this machine, started .+\) stopped with apps\/acme moved to \.mixos\/backup\/apps\/acme\/, before it was removed\.$/);
    const result = await recoverCheckout({ ...options(), command: "npm run remove -- --recover", confirm: async () => true });
    assert.equal(result.acted.length, 1);
    assert.equal(exists("apps/acme/app.json"), true);
    assert.deepEqual(runs()[0].apps, ["acme"]);
  });

  test("one the generator accepted is finished: what is left of the backup is deleted, with no regenerating", async () => {
    const where = killedAfterMove("acme", { accepted: true });
    fs.rmSync(path.join(where.folder, "api"), { recursive: true });
    const [item] = planRecovery(root);
    assert.equal(item.action, "finish-removal");
    const result = await recoverCheckout({ ...options(), confirm: async () => true });
    assert.equal(result.regenerated, null);
    assert.equal(fs.existsSync(where.folder), false);
    assert.equal(fs.existsSync(where.record), false);
    assert.equal(exists("apps/acme"), false);
    assert.equal(audit[0].details.action, "finish-removal");
  });

  test("a record left before the folder moved is cleared, and the folder left where it is", async () => {
    app("acme");
    const where = backupLocation(root, "app", "acme");
    writeBackupRecord(where.record, recordOf("acme"));
    const [item] = planRecovery(root);
    assert.equal(item.action, "clear-backup-record");
    await recoverCheckout({ ...options(), confirm: async () => true });
    assert.equal(fs.existsSync(where.record), false);
    assert.equal(exists("apps/acme/app.json"), true);
  });

  test("leaves alone a removal that still holds the checkout lock", async () => {
    const lock = tryAcquireCheckoutLock(root, "a removal of app/acme (npm run remove)");
    try {
      killedAfterMove("acme", { token: lock.token, pid: process.pid });
      const [item] = planRecovery(root);
      assert.equal(item.action, "restore-backup");
      assert.match(item.blocked ?? "", /is still running\. Let it finish, or stop it/);
    } finally {
      lock.release();
    }
    // Once it has stopped, its lock no longer holds the token.
    assert.equal(planRecovery(root)[0].blocked, null);
  });

  test("one whose lock holder has stopped on this machine isn't waited for", async () => {
    killedAfterMove("acme");
    // The dead removal's lock, still on disk.
    fs.writeFileSync(
      path.join(root, ".mixos", "lock"),
      JSON.stringify({ pid: 999999, hostname: os.hostname(), token: "a-removal-that-stopped-0001", purpose: "npm run remove", since: "2026-10-11T09:00:00.000Z" }),
    );
    assert.equal(planRecovery(root)[0].blocked, null);
    const result = await recoverCheckout({ ...options(), confirm: async () => true });
    assert.equal(result.acted.length, 1);
    assert.equal(exists("apps/acme/app.json"), true);
  });

  test("leaves to a person a backup it can't place: no record, an unreadable one, or both copies there", async () => {
    const orphan = backupLocation(root, "app", "orphan");
    fs.mkdirSync(orphan.folder, { recursive: true });
    const unread = backupLocation(root, "app", "unread");
    fs.mkdirSync(unread.folder, { recursive: true });
    fs.writeFileSync(unread.record, "{ not json");
    const both = killedAfterMove("both");
    app("both");
    const lone = backupLocation(root, "connector", "lone");
    fs.mkdirSync(path.dirname(lone.record), { recursive: true });
    fs.writeFileSync(lone.record, '{"operation":"update"}');

    const items = planRecovery(root);
    const by = (p: string) => items.find((i) => i.path === p)!;
    assert.equal(by(orphan.rel).action, "resolve-by-hand");
    assert.match(by(orphan.rel).blocked ?? "", /Move it back to apps\/orphan by hand, or delete it/);
    assert.equal(by(unread.rel).action, "resolve-by-hand");
    assert.equal(by(both.rel).action, "resolve-by-hand");
    assert.match(by(both.rel).blocked ?? "", /can't tell which copy to keep/);
    // An unreadable record with nothing beside it is only deleted.
    assert.equal(by(lone.rel).action, "drop-backup-record");
    const result = await recoverCheckout({ ...options(), confirm: async () => true });
    assert.deepEqual(result.acted.map((i) => i.path), [lone.rel]);
    assert.equal(fs.existsSync(lone.record), false);
    assert.equal(fs.existsSync(orphan.folder), true);
  });

  test("Register refuses a name whose removal stopped midway", async () => {
    killedAfterMove("acme");
    pend("app", "acme");
    await assert.rejects(
      registerPending("app", "acme", { actor: ACTOR, via: "cli", root, generator: STAND_IN, notice: () => {} }),
      (err: unknown) =>
        describeRegisterFailure(err).code === "interrupted" && /npm run remove -- --recover/.test(describeRegisterFailure(err).message),
    );
    assert.equal(exists("apps/acme"), false);
  });
});
