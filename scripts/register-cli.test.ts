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
import { backupLocation, writeBackupRecord } from "../src/lib/repository/backup";
import { filesHash, hashFileTree } from "../src/lib/repository/content-hash";
import { INSTALL_RECORD_FILE, folderFilesHash, serializeInstallRecord } from "../src/lib/repository/install-record";
import { pendingLocation, writeSidecar, type PendingKind, type PendingSidecar } from "../src/lib/repository/pending";
import { updateRecordFor } from "../src/lib/repository/register";
import type { TarEntry } from "../src/lib/repository/tar";
import { cliActor, parseArgs, printable, resolveTarget, runCli } from "./register-cli";
import { childEnv, type ChildRun, type SmokeSteps } from "./register-smoke";

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

function pend(kind: PendingKind, slug: string, tree: TarEntry[] = TREE, sidecar: Pick<PendingSidecar, "leftOut" | "replaces"> = {}) {
  const where = pendingLocation(root, kind, slug);
  fs.mkdirSync(where.folder, { recursive: true });
  for (const e of tree) fs.writeFileSync(path.join(where.folder, e.path), e.data);
  fs.writeFileSync(
    path.join(where.folder, INSTALL_RECORD_FILE),
    serializeInstallRecord({
      source: "https://mixos.org",
      kind,
      slug,
      version: "1.2.0",
      gitTag: null,
      commitSha: "d".repeat(40),
      contentHash: hashFileTree(tree),
      filesHash: filesHash(tree),
      repository: { owner: "acme", name: `mixos-${slug}`, subpath: null },
      requiresMixOS: null,
    }),
  );
  writeSidecar(where.sidecar, {
    kind,
    slug,
    yankedAccepted: false,
    installedAt: "2026-10-11T09:00:00.000Z",
    installedBy: "admin@example.com",
    check: { verdict: "accepted", deferred: [] },
    ...sidecar,
  });
  return where;
}

/** A terminal: what was printed, and the answers to give, in order: yes or no, and which way when asked to choose. */
function terminal(answers: boolean[] = [], choices: string[] = []) {
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
      choose: async (question: string, keys: readonly string[]) => {
        asked.push(`${question} [${keys.join("/")}]`);
        return choices.shift() ?? null;
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

  test("--smoke and what goes with it", () => {
    assert.deepEqual(parseArgs(["app/acme", "--smoke"]), {
      mode: "register",
      target: "app/acme",
      smoke: { databaseIsDisposable: false },
    });
    assert.deepEqual(
      parseArgs(["--smoke", "acme", "--base-url", "http://localhost:3118", "--confirm-replaces=acme", "--database-is-disposable"]),
      {
        mode: "register",
        target: "acme",
        smoke: { databaseIsDisposable: true, baseUrl: "http://localhost:3118", confirmReplaces: "acme" },
      },
    );
    const refused: [string[], RegExp][] = [
      [["--smoke"], /--smoke needs the app to register/],
      [["app/acme", "--base-url", "http://localhost:3000"], /--base-url goes with --smoke/],
      [["app/acme", "--database-is-disposable"], /--database-is-disposable goes with --smoke/],
      [["app/acme", "--confirm-replaces", "acme"], /--confirm-replaces goes with --smoke/],
      [["app/acme", "--smoke", "--discard"], /--smoke goes with registering an app, not with --discard/],
      [["--recover", "--smoke"], /--smoke goes with registering an app/],
      [["app/acme", "--smoke", "--smoke"], /Give --smoke once/],
      [["app/acme", "--smoke", "--base-url"], /--base-url needs a value/],
      [["app/acme", "--smoke", "--confirm-replaces", "--database-is-disposable"], /--confirm-replaces needs a value/],
      [["app/acme", "--smoke", "--base-url", "ftp://example.com"], /--base-url must be http or https/],
      [["app/acme", "--smoke=yes"], /Unknown option --smoke=yes/],
      [["app/acme", "--discard=1"], /Unknown option --discard=1/],
    ];
    for (const [args, message] of refused) {
      const parsed = parseArgs(args);
      assert.ok("error" in parsed, args.join(" "));
      assert.match(parsed.error, message, args.join(" "));
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

  test("registers by slug alone, and hands back what to commit and how", async () => {
    pend("app", "acme");
    const t = terminal();
    assert.equal(await cli(["acme"], t), 0, t.err.join("\n"));
    const out = t.out.join("\n");
    assert.match(out, /Registered app\/acme 1\.2\.0 from commit dddddddddddd\./);
    assert.match(out, /It runs in this checkout now, and nowhere else until you commit apps\/acme and deploy it\./);
    assert.match(out, /Files added in apps\/acme\/ \(2 files, \d+ B\):\n {4}\.registry\.json +\d+ B\n {4}app\.json +16 B/);
    // The commands, unindented, so a here-document's lines are the message's.
    assert.match(
      out,
      /^git switch -c add-app-acme\ngit add apps\/acme\ngit commit -F - -- apps\/acme <<'MSG'\nfeat\(acme\): add app acme 1\.2\.0 from mixos\.org\n/m,
    );
    assert.match(out, /^Registry-Listing: https:\/\/mixos\.org\/extend\/apps\/acme\nMSG\ngit push -u origin HEAD$/m);
    assert.match(out, /Or run \/mixos deploy/);
    assert.match(out, /https:\/\/github\.com\/acme\/mixos-acme\/tree\/d{40}/);
    assert.match(out, /It arrives inactive on each instance/);
    assert.doesNotMatch(out, /\.gitignore leaves/);
    assert.doesNotMatch(out, /Left out/);
    assert.ok(fs.existsSync(path.join(root, "apps", "acme", "app.json")));
    assert.ok(fs.existsSync(path.join(root, "apps", "acme", INSTALL_RECORD_FILE)));
    assert.deepEqual(audit, [{ actor_id: null, actor_email: "cli:tester@test-host", action: "app.register" }]);
  });

  test("says in one line what install left out of the package, after what it registered", async () => {
    pend("app", "acme", TREE, { leftOut: { ".gitignore": 1, ".gitattributes": 2 } });
    const t = terminal();
    assert.equal(await cli(["app/acme"], t), 0, t.err.join("\n"));
    const out = t.out.join("\n");
    assert.match(
      out,
      /\nRegistered to apps\/acme: [^\n]+\nLeft out \.gitignore \(1 file\) and \.gitattributes \(2 files\): MixOS doesn't install git control files\.\n/,
    );
    assert.equal(out.match(/Left out/g)?.length, 1);
  });

  test("warns, and adds by name, a file the checkout's .gitignore would leave out of the commit", async (t) => {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmp } as unknown as NodeJS.ProcessEnv });
    if (git("init", "-q").status !== 0) {
      t.skip("git isn't available");
      return;
    }
    fs.writeFileSync(path.join(root, ".gitignore"), "*.pem\n.env*\n!.env*.example\n");
    pend("app", "acme", [
      ...TREE,
      { path: "cert.pem", mode: 0o644, data: Buffer.from("-----BEGIN CERTIFICATE-----\n") },
      { path: ".env.example", mode: 0o644, data: Buffer.from("A=1\n") },
    ]);
    const term = terminal();
    assert.equal(await cli(["app/acme"], term), 0, term.err.join("\n"));
    const out = term.out.join("\n");
    assert.match(out, /Your \.gitignore leaves this file out of `git add apps\/acme`/);
    assert.match(out, /apps\/acme\/cert\.pem {2}\(\.gitignore:1:\*\.pem\)/);
    // A rule that keeps a file in isn't a warning.
    assert.doesNotMatch(out, /apps\/acme\/\.env\.example {2}\(/);
    assert.match(out, /^git add apps\/acme\ngit add -f apps\/acme\/cert\.pem\n/m);
  });

  test("asks git nothing it would change, and stays quiet outside a git checkout", async () => {
    const calls: string[][] = [];
    const fake = ((command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { status: 128, stdout: "", stderr: "fatal: not a git repository", error: undefined };
    }) as unknown as typeof spawnSync;
    pend("app", "acme");
    const t = terminal();
    assert.equal(
      await runCli(["app/acme"], { root, io: t.io, generator: STAND_IN, actor: { id: null, email: "cli:tester@test-host" }, git: fake }),
      0,
    );
    assert.deepEqual(calls, [["git", "check-ignore", "--verbose", "-z", "--stdin"]]);
    assert.doesNotMatch(t.out.join("\n"), /\.gitignore leaves/);
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

  test("registers a pending update, saying what it replaces, and hands back the change and how to roll it back", async () => {
    const OLD: TarEntry[] = [{ path: "app.json", mode: 0o644, data: Buffer.from('{"name":"Acme Old"}\n') }];
    const live = path.join(root, "apps", "acme");
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "app.json"), OLD[0].data);
    fs.writeFileSync(
      path.join(live, INSTALL_RECORD_FILE),
      serializeInstallRecord({
        source: "https://mixos.org",
        kind: "app",
        slug: "acme",
        version: "1.1.0",
        gitTag: null,
        commitSha: "a".repeat(40),
        contentHash: hashFileTree(OLD),
        filesHash: filesHash(OLD),
        repository: { owner: "acme", name: "mixos-acme", subpath: null },
        requiresMixOS: null,
      }),
    );
    pend("app", "acme", TREE, {
      replaces: {
        version: "1.1.0",
        gitTag: null,
        commitSha: "a".repeat(40),
        filesHash: filesHash(OLD),
        folderHash: folderFilesHash(live),
        localChangesDiscarded: false,
        direction: "newer",
      },
    });
    const t = terminal();
    assert.equal(await cli(["app/acme"], t), 0, t.err.join("\n"));
    const out = t.out.join("\n");
    assert.match(out, /^Updating app\/acme from 1\.1\.0\. This moves apps\/acme aside and runs the new release's code for the first time\.\.\.$/m);
    assert.match(out, /^Updated app\/acme from 1\.1\.0 to 1\.2\.0 from commit dddddddddddd\.$/m);
    assert.match(out, /^Updated apps\/acme from 1\.1\.0 to 1\.2\.0: the registry generator loaded the new code and accepted it/m);
    assert.match(out, /^What the commit changes in apps\/acme\/ \(2 changed, 0 added, 0 deleted\):$/m);
    assert.match(out, /^git switch -c update-app-acme\ngit add apps\/acme\ngit commit -F - -- apps\/acme <<'MSG'\nfeat\(acme\): update app acme from 1\.1\.0 to 1\.2\.0\n/m);
    assert.match(out, /To roll it back once it is deployed, revert the commit and deploy again/);
    assert.doesNotMatch(out, /arrives inactive/);
    assert.equal(fs.readFileSync(path.join(live, "app.json"), "utf8"), '{"name":"Acme"}\n');
    assert.equal(fs.existsSync(path.join(root, ".mixos/backup/apps/acme")), false);
  });

  test("--recover asks which way an update with its release in place goes, then whether to go ahead", async () => {
    // What an update killed while the generator ran leaves: 1.2.0 in place,
    // 1.1.0 in its backup, and the records of both.
    const OLD: TarEntry[] = [{ path: "app.json", mode: 0o644, data: Buffer.from('{"name":"Acme Old"}\n') }];
    const backup = backupLocation(root, "app", "acme");
    fs.mkdirSync(backup.folder, { recursive: true });
    fs.writeFileSync(path.join(backup.folder, "app.json"), OLD[0].data);
    const where = pend("app", "acme", TREE);
    const dead = { token: "an-update-that-stopped-0002", pid: 999999, hostname: os.hostname(), startedAt: new Date().toISOString() };
    writeSidecar(where.sidecar, {
      kind: "app",
      slug: "acme",
      yankedAccepted: false,
      installedAt: "2026-10-11T09:00:00.000Z",
      installedBy: "admin@example.com",
      check: { verdict: "accepted", deferred: [] },
      replaces: {
        version: "1.1.0",
        gitTag: null,
        commitSha: "a".repeat(40),
        filesHash: filesHash(OLD),
        folderHash: filesHash(OLD),
        localChangesDiscarded: false,
        direction: "newer",
      },
      register: dead,
    });
    writeBackupRecord(backup.record, {
      ...updateRecordFor(
        "app",
        "acme",
        dead.token,
        { version: "1.1.0", gitTag: null, commitSha: "a".repeat(40), folderHash: filesHash(OLD) },
        { version: "1.2.0", gitTag: null, commitSha: "d".repeat(40), filesHash: filesHash(TREE) },
      ),
      pid: dead.pid,
    });
    fs.renameSync(where.folder, path.join(root, "apps", "acme"));

    const t = terminal([true], ["k"]);
    assert.equal(await cli(["--recover"], t), 0, t.err.join("\n"));
    const out = t.out.join("\n");
    assert.deepEqual(t.asked, ["Restore 1.1.0, or keep 1.2.0? [r/k]", "Go ahead?"]);
    assert.match(out, /^It can go either way:\n {2}\.mixos\/backup\/apps\/acme\n {4}An update of acme from 1\.1\.0 to 1\.2\.0 \(pid 999999 on this machine, started [^)]+\) stopped with 1\.2\.0 in apps\/acme and 1\.1\.0 in \.mixos\/backup\/apps\/acme\/, before the registry generator accepted 1\.2\.0\.\n {4}r: Restore 1\.1\.0: move 1\.2\.0 back to \.mixos\/pending\/apps\/acme\/, move 1\.1\.0 back to apps\/acme, and regenerate the registry\.\n {4}k: Keep 1\.2\.0: /m);
    assert.match(out, /Recovery will: Keep 1\.2\.0: run the registry generator with it in place/);
    assert.match(out, /^Done: \.mixos\/backup\/apps\/acme\.$/m);
    assert.equal(fs.readFileSync(path.join(root, "apps/acme/app.json"), "utf8"), '{"name":"Acme"}\n');
    assert.equal(fs.existsSync(backup.folder), false);
    assert.equal(fs.existsSync(where.sidecar), false);
    assert.deepEqual(audit.map((r) => r.action), ["app.update.recover"]);
  });

  test("--recover in a tidy checkout says there is nothing to do", async () => {
    const t = terminal();
    assert.equal(await cli(["--recover"], t), 0);
    assert.deepEqual(t.asked, []);
    assert.match(t.out.join("\n"), /Nothing to recover/);
  });
});

// ── --smoke ─────────────────────────────────────────────────────────────────

describe("--smoke", () => {
  const COOKIE = "authjs.session-token=s3ss10n-c00kie-value";
  const BASE = "http://localhost:3118";

  /** One JSON line, as scripts/smoke-activate.ts prints it. */
  const answer = (value: unknown, code = 0): ChildRun => ({ code, stdout: `${JSON.stringify(value)}\n`, stderr: "" });

  /** The verdict line, as scripts/smoke-test-app.ts prints it. */
  const verdict = (ok: boolean, status = "tested"): ChildRun =>
    answer(
      {
        ok,
        baseUrl: BASE,
        user: "admin@example.com",
        counts: { pass: ok ? 2 : 0, fail: ok ? 0 : 2, blocked: 0, skipped: 0 },
        apps: [{ slug: "acme", status, ok, routes: [] }],
      },
      ok ? 0 : 1,
    );

  /** Stand-ins for everything --smoke reaches, logging each call in order. */
  function steps(over: Partial<SmokeSteps> = {}) {
    const calls: string[] = [];
    const s: SmokeSteps = {
      database: () => (calls.push("database"), { hosts: ["localhost"], local: true }),
      signIn: async (baseUrl) => (calls.push(`signIn ${baseUrl}`), { cookie: COOKIE, user: "admin@example.com" }),
      userExists: async (email) => (calls.push(`userExists ${email}`), true),
      appRow: async (slug) => (calls.push(`appRow ${slug}`), null),
      migrate: async (onLine) => {
        calls.push("migrate");
        onLine("App migrations complete.");
        return { code: 0, stdout: "", stderr: "" };
      },
      activate: async (input) => {
        calls.push(`activate ${JSON.stringify(input)}`);
        return answer({ ok: true, activated: true, replaced: null, grant: "added" });
      },
      smoke: async (input, onLine) => {
        calls.push(`smoke ${input.slug} ${input.baseUrl} ${input.cookie}`);
        onLine("[smoke] acme: tested");
        return verdict(true);
      },
      ...over,
    };
    return { steps: s, calls };
  }

  const smokeCli = (args: string[], s: SmokeSteps, t = terminal()) =>
    runCli(args, { root, io: t.io, generator: STAND_IN, actor: { id: null, email: "cli:tester@test-host" }, smoke: s });

  const registered = () => fs.existsSync(path.join(root, "apps", "acme", "app.json"));

  test("registers, then migrates, activates and grants, and smoke-tests, in that order, after Register", async () => {
    pend("app", "acme");
    const { steps: s, calls } = steps();
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", `${BASE}/`], s, t), 0, t.err.join("\n"));
    assert.deepEqual(calls, [
      "database",
      `signIn ${BASE}`,
      "userExists admin@example.com",
      "appRow acme",
      "migrate",
      'activate {"slug":"acme","email":"admin@example.com","actor":"cli:tester@test-host"}',
      `smoke acme ${BASE} ${COOKIE}`,
    ]);
    assert.deepEqual(audit.map((a) => a.action), ["app.register"]);
    const out = t.out.join("\n");
    assert.match(out, /Registered app\/acme 1\.2\.0[\s\S]*git push -u origin HEAD[\s\S]*Smoke test: migrating, activating and granting acme in this checkout's database \(localhost\), then calling its routes at http:\/\/localhost:3118 as admin@example\.com\./);
    assert.match(out, /^ {4}App migrations complete\.$/m);
    assert.match(out, /^Activated acme in this checkout's database \(localhost\)\.\nGranted acme to admin@example\.com\.\n\[smoke\] acme: tested\nThe smoke test passed\./m);
    assert.doesNotMatch(out + t.err.join("\n"), /s3ss10n-c00kie-value/, "the session never reaches the output");
  });

  test("on a database that isn't on this machine, it refuses before anything is registered", async () => {
    pend("app", "acme");
    const { steps: s, calls } = steps({ database: () => ({ hosts: ["db.example.com"], local: false }) });
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke"], s, t), 1);
    assert.deepEqual(calls, []);
    assert.match(
      t.err.join("\n"),
      /^--smoke runs only against a database on this machine, and this checkout's is on db\.example\.com\. Other instances may use it too: --smoke would apply app\/acme's migrations there before anyone has reviewed them in a pull request[\s\S]*add --database-is-disposable\.\nNothing was registered\.$/,
    );
    assert.equal(registered(), false);
    assert.deepEqual(audit, []);
  });

  test("--database-is-disposable lets it run there, and says so", async () => {
    pend("app", "acme");
    const { steps: s } = steps({ database: () => ({ hosts: ["db.example.com"], local: false }) });
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke", "--database-is-disposable", "--base-url", BASE], s, t), 0, t.err.join("\n"));
    assert.match(t.out.join("\n"), /This checkout's database is on db\.example\.com, which you said is disposable/);
  });

  test("a connector has no routes to test: refused before anything is registered", async () => {
    pend("connector", "probe");
    const { steps: s, calls } = steps();
    const t = terminal();
    assert.equal(await smokeCli(["connector/probe", "--smoke"], s, t), 2);
    assert.match(t.err.join("\n"), /--smoke tests an app's routes, and a connector has none of its own/);
    assert.deepEqual(calls, []);
    assert.deepEqual(audit, []);
  });

  test("no server, or no sign-in: refused before anything is registered", async () => {
    pend("app", "acme");
    const { SmokeSetupError } = await import("./app-smoke");
    const { steps: s } = steps({
      signIn: async () => {
        throw new SmokeSetupError("can't reach http://localhost:3118: ECONNREFUSED");
      },
    });
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE], s, t), 1);
    assert.match(t.err.join("\n"), /couldn't: can't reach http:\/\/localhost:3118: ECONNREFUSED\.\nStart it with `npm run dev`[\s\S]*Nothing was registered\.$/);
    assert.equal(registered(), false);
  });

  test("a server on another database, whose user this one doesn't have: refused", async () => {
    pend("app", "acme");
    const { steps: s } = steps({ userExists: async () => false });
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE], s, t), 1);
    assert.match(t.err.join("\n"), /signed in admin@example\.com, who isn't in this checkout's database \(localhost\)\. So the server uses another database/);
    assert.equal(registered(), false);
  });

  describe("an app that replaces a different extension under its slug", () => {
    const local = { isActive: true, identity: "local", identityChangedAt: null, replacedIdentity: null };

    test("is refused without its slug typed, with the command that types it", async () => {
      pend("app", "acme");
      const { steps: s, calls } = steps({ appRow: async () => local });
      const t = terminal();
      assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE], s, t), 1);
      const err = t.err.join("\n");
      assert.match(
        err,
        /^app\/acme replaces a different extension under the same name: this checkout's database knows acme as local, with no install record, and this install is from mixos\.org, acme\/mixos-acme\./,
      );
      assert.match(err, /\nTo do that knowingly, type its slug:\n {2}npm run register -- app\/acme --smoke --base-url http:\/\/localhost:3118 --confirm-replaces acme\n/);
      assert.match(err, /activate it in Admin > Apps, which asks for its slug too\.\nNothing was registered\.$/);
      assert.ok(!calls.some((c) => c.startsWith("migrate")));
      assert.equal(registered(), false);
      assert.deepEqual(audit, []);
    });

    test("so is one a release step has already flagged, whatever it was", async () => {
      pend("app", "acme");
      const flagged = {
        isActive: false,
        identity: "https://mixos.org app/acme acme/mixos-acme",
        identityChangedAt: new Date(),
        replacedIdentity: "local",
      };
      const { steps: s } = steps({ appRow: async () => flagged });
      const t = terminal();
      assert.equal(await smokeCli(["app/acme", "--smoke"], s, t), 1);
      assert.match(t.err.join("\n"), /knows acme as local, with no install record/);
    });

    test("with --confirm-replaces <slug>, it goes ahead, and activation gets the typed slug", async () => {
      pend("app", "acme");
      const { steps: s, calls } = steps({
        appRow: async () => local,
        activate: async (input) => {
          calls.push(`activate ${JSON.stringify(input)}`);
          return answer({ ok: true, activated: true, replaced: "local", grant: "existing" });
        },
      });
      const t = terminal();
      assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE, "--confirm-replaces", "acme"], s, t), 0, t.err.join("\n"));
      assert.ok(calls.includes('activate {"slug":"acme","email":"admin@example.com","typedSlug":"acme","actor":"cli:tester@test-host"}'));
      assert.match(t.out.join("\n"), /Activated acme in this checkout's database \(localhost\), in place of a local extension\.\nadmin@example\.com already had acme\./);
    });

    test("--confirm-replaces naming another slug is a usage error", async () => {
      pend("app", "acme");
      const t = terminal();
      assert.equal(await smokeCli(["app/acme", "--smoke", "--confirm-replaces", "other"], steps().steps, t), 2);
      assert.match(t.err.join("\n"), /--confirm-replaces names other, and this registers acme/);
    });

    test("--confirm-replaces for an app that replaces nothing is said, and changes nothing", async () => {
      pend("app", "acme");
      const t = terminal();
      assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE, "--confirm-replaces", "acme"], steps().steps, t), 0);
      assert.match(t.out.join("\n"), /--confirm-replaces acme: acme doesn't replace a different extension, so there is nothing to confirm\./);
    });
  });

  test("a failed smoke test exits 1 and says what stays: nothing is rolled back", async () => {
    pend("app", "acme");
    const { steps: s } = steps({ smoke: async () => verdict(false, "inactive") });
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE], s, t), 1);
    const out = t.out.join("\n");
    assert.match(out, /The smoke test failed\. Nothing was rolled back: acme stays registered, migrated, active and granted here\./);
    assert.match(out, /^ {2}SMOKE_EMAIL=admin@example\.com SMOKE_PASSWORD=<password> npx tsx scripts\/smoke-test-app\.ts acme --base-url http:\/\/localhost:3118$/m);
    assert.match(out, /Every route answered 404, so the server isn't serving acme yet\. npm run dev can keep serving what it loaded before an app's folder was replaced: restart it\./);
    assert.equal(registered(), true);
  });

  test("a smoke test that couldn't run says why", async () => {
    pend("app", "acme");
    const { steps: s } = steps({
      smoke: async () => answer({ ok: false, baseUrl: BASE, user: null, counts: {}, apps: [], error: "no server" }, 2),
    });
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE], s, t), 1);
    assert.match(t.out.join("\n"), /The smoke test couldn't run: no server\. acme is registered, migrated, active and granted here\./);
  });

  test("a failed migration stops it before activation", async () => {
    pend("app", "acme");
    const { steps: s, calls } = steps({ migrate: async () => (calls.push("migrate"), { code: 1, stdout: "", stderr: "" }) });
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE], s, t), 1);
    assert.match(t.out.join("\n"), /npm run migrate:apps failed \(exit 1\), so the smoke test stopped there\. acme is registered, and inactive\./);
    assert.ok(!calls.some((c) => c.startsWith("activate") || c.startsWith("smoke")));
  });

  test("the migration and the activation get the database, and not the smoke user's credentials", () => {
    const env = childEnv({
      DATABASE_URL: "postgres://x",
      PATH: "/bin",
      SMOKE_EMAIL: "a@b.c",
      SMOKE_PASSWORD: "pw",
      SMOKE_COOKIE: "c",
    } as unknown as NodeJS.ProcessEnv);
    assert.deepEqual(env, { DATABASE_URL: "postgres://x", PATH: "/bin" });
  });

  test("activation's own refusal stops it before the smoke test, with what to do", async () => {
    pend("app", "acme");
    const { steps: s, calls } = steps({
      activate: async () => answer({ ok: false, code: "connectors", message: "Configure Acme CRM before activating this app." }, 1),
    });
    const t = terminal();
    assert.equal(await smokeCli(["app/acme", "--smoke", "--base-url", BASE], s, t), 1);
    assert.match(
      t.out.join("\n"),
      /Configure Acme CRM before activating this app\. acme is registered and migrated, and wasn't activated\. Configure it in Admin > Connectors, activate acme in Admin > Apps, then run the smoke test:/,
    );
    assert.ok(!calls.some((c) => c.startsWith("smoke")));
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
