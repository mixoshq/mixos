/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `npm run remove`: its arguments, a name alone, what it shows and asks, what
 * it asks git, and its exit codes. runCli() is given a checkout of the test's
 * own, a stand-in for the registry generator, a stubbed database pool and its
 * own input and output. The last test runs the script itself.
 */

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupLocation, writeBackupRecord } from "../src/lib/repository/backup";
import { parseArgs, resolveTarget, runCli, trackedByGit, uncommittedPaths } from "./remove-cli";

// ── the database: the register lock, the applied theme and the audit rows ───

let audit: { actor_id: unknown; actor_email: unknown; action: unknown; details: Record<string, unknown> }[] = [];
(globalThis as { __pg?: unknown }).__pg = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert into public._platform_locks")) return [{ holder: values[1] }];
    if (text.startsWith("update public._platform_locks")) return [{ held: 1 }];
    if (text.startsWith("select value from public.platform_settings")) return [{ value: "dusk" }];
    if (text.startsWith("insert into public.admin_audit_log")) {
      audit.push({
        actor_id: values[0],
        actor_email: values[1],
        action: values[2],
        details: (values[5] as { json: Record<string, unknown> }).json,
      });
    }
    return [];
  },
  { json: (value: unknown) => ({ json: value }) },
);

// ── checkouts, a generator, and a terminal ──────────────────────────────────

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-remove-cli-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Registers every folder in apps/, connectors/ and themes/ but the one `--without <kind>/<slug>` names. */
const STAND_IN = path.join(tmp, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const args = process.argv.slice(2);
const without = args.includes("--without") ? args[args.indexOf("--without") + 1] : null;
const list = (dir) =>
  (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : [])
    .filter((name) => !(without && without.split("/")[0] + "s" === dir && without.split("/")[1] === name));
fs.mkdirSync("src/generated", { recursive: true });
fs.writeFileSync("src/generated/app-registry.ts", JSON.stringify(list("apps").map((slug) => ({ slug })), null, 2));
fs.writeFileSync("src/generated/connector-registry.ts", JSON.stringify(list("connectors").map((name) => ({ name })), null, 2));
fs.writeFileSync("src/generated/theme-registry.ts", JSON.stringify(list("themes").map((slug) => ({ slug })), null, 2));
`,
);

let n = 0;
let root: string;
beforeEach(() => {
  root = path.join(tmp, `checkout-${n++}`);
  for (const dir of ["apps", "connectors", "themes"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  audit = [];
});

const write = (rel: string, data: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

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

/** A stand-in for git: `status` and `ls-files` print what the test says, or exit 128 as outside a work tree. */
function fakeGit({ status, tracked }: { status?: string[]; tracked?: boolean } = {}) {
  return ((command: string, args: readonly string[]) => {
    assert.equal(command, "git");
    if (args[0] === "status" && status) return { status: 0, stdout: status.map((s) => `${s}\0`).join("") };
    if (args[0] === "ls-files" && tracked !== undefined) return { status: 0, stdout: tracked ? "apps/acme/app.json\0" : "" };
    return { status: 128, stdout: "" };
  }) as unknown as typeof spawnSync;
}

const cli = (args: string[], t = terminal(), git = fakeGit()) =>
  runCli(args, { root, io: t.io, generator: STAND_IN, git, actor: { id: null, email: "cli:tester@test-host" } });

// ── arguments ───────────────────────────────────────────────────────────────

describe("arguments", () => {
  test("each command, and what isn't one", () => {
    assert.deepEqual(parseArgs([]), { mode: "list" });
    assert.deepEqual(parseArgs(["app/acme"]), { mode: "remove", target: "app/acme" });
    assert.deepEqual(parseArgs(["--recover"]), { mode: "recover" });
    assert.deepEqual(parseArgs(["--break-lock"]), { mode: "break-lock" });
    assert.match((parseArgs(["--discard", "app/acme"]) as { error: string }).error, /Unknown option --discard/);
    assert.match((parseArgs(["--recover", "app/acme"]) as { error: string }).error, /takes no extension/);
    assert.match((parseArgs(["--recover", "--break-lock"]) as { error: string }).error, /one of/);
    assert.match((parseArgs(["app/a", "app/b"]) as { error: string }).error, /one extension at a time/);
  });

  test("a kind and a name, or a name alone when only one kind has it", () => {
    write("apps/acme/app.json", "{}");
    write("themes/dusk/theme.json", "{}");
    write("apps/both/app.json", "{}");
    write("themes/both/theme.json", "{}");
    assert.deepEqual(resolveTarget(root, "app/acme"), { kind: "app", slug: "acme" });
    assert.deepEqual(resolveTarget(root, "themes/dusk"), { kind: "theme", slug: "dusk" });
    assert.deepEqual(resolveTarget(root, "acme"), { kind: "app", slug: "acme" });
    assert.deepEqual(resolveTarget(root, "dusk"), { kind: "theme", slug: "dusk" });
    assert.match((resolveTarget(root, "both") as { error: string }).error, /Say app\/both or theme\/both/);
    assert.match((resolveTarget(root, "ghost") as { error: string }).error, /Nothing named ghost/);
    assert.match((resolveTarget(root, "plugin/acme") as { error: string }).error, /not app, connector or theme/);
    assert.match((resolveTarget(root, "app/../etc") as { error: string }).error, /not <kind>\/<slug>/);
    assert.match((resolveTarget(root, "app/_template") as { error: string }).error, /not the name of an extension/);
  });
});

// ── removing ────────────────────────────────────────────────────────────────

describe("removing", () => {
  test("shows what goes and what stays, asks, and on a no changes nothing", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    const t = terminal([false]);
    assert.equal(await cli(["app/acme"], t), 1);
    const out = t.out.join("\n");
    assert.match(out, /^Acme, app\/acme, in apps\/acme\/:\n {2}Removing it deletes apps\/acme\/ from this checkout and regenerates the registry without it\./);
    assert.match(out, /It has no install record/);
    assert.match(out, /Its data stays in this checkout's database and in every other that has it/);
    assert.deepEqual(t.asked, ["Remove app/acme from this checkout?"]);
    assert.match(out, /Nothing was changed\.$/);
    assert.equal(exists("apps/acme/app.json"), true);
    assert.deepEqual(audit, []);
  });

  test("on a yes, removes it, says what stays, and prints the commit to make", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    const t = terminal([true]);
    assert.equal(await cli(["acme"], t, fakeGit({ status: [], tracked: true })), 0, t.err.join("\n"));
    const out = t.out.join("\n");
    assert.equal(exists("apps/acme"), false);
    assert.match(out, /Removed apps\/acme from this checkout, and the registry no longer has it\./);
    assert.match(out, /Files deleted from apps\/acme\/ \(1 file, \d+ B\):/);
    assert.match(out, /^git switch -c remove-app-acme\ngit rm -r apps\/acme\ngit commit -F - -- apps\/acme <<'MSG'\nfeat\(acme\): remove app acme$/m);
    assert.match(out, /Commit the deletion and deploy: each instance keeps the app's data until an admin deletes it there\./);
    assert.equal(audit[0].action, "app.remove");
    assert.equal(audit[0].actor_id, null);
    assert.equal(audit[0].actor_email, "cli:tester@test-host");
    assert.equal(audit[0].details.via, "cli");
  });

  test("warns about work git hasn't committed, and says when there is nothing to commit", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    const t = terminal([true]);
    const git = fakeGit({ status: ["?? apps/acme/app.json", " M apps/acme/README.md", "R  apps/acme/new.ts", "apps/acme/old.ts"], tracked: false });
    assert.equal(await cli(["app/acme"], t, git), 0);
    const out = t.out.join("\n");
    assert.match(out, /Git lists 3 paths in apps\/acme with work that isn't committed\. Removing it deletes that work:\n {4}apps\/acme\/app\.json\n {4}apps\/acme\/README\.md\n {4}apps\/acme\/new\.ts/);
    assert.match(out, /Git doesn't track apps\/acme: it was never committed, so there is nothing to commit\./);
    assert.doesNotMatch(out, /git switch/);
  });

  test("names what refuses it, asks nothing, and exits 1", async () => {
    write("connectors/probe/connector.json", '{"name":"probe","displayName":"Probe"}');
    write("apps/mailer/app.json", '{"name":"Mailer","connectors":[{"name":"probe","version":"1.0.0"}]}');
    const t = terminal([true]);
    assert.equal(await cli(["connector/probe"], t), 1);
    const out = t.out.join("\n");
    assert.match(out, /It can't be removed yet:\n {2}Required by Mailer \(apps\/mailer\), which can't work without it\./);
    assert.deepEqual(t.asked, []);
    assert.equal(exists("connectors/probe/connector.json"), true);
  });

  test("shows a warning before asking, and the last theme can't be removed", async () => {
    write("themes/aurora/theme.json", '{"name":"Aurora"}');
    write("themes/dusk/theme.json", '{"name":"Dusk"}');
    const t = terminal([true]);
    assert.equal(await cli(["theme/dusk"], t), 0);
    assert.match(t.out.join("\n"), /Note: It is the applied theme in this checkout's database, so pages here use Aurora/);
    assert.match(t.out.join("\n"), /A theme holds no data\./);

    const last = terminal([true]);
    assert.equal(await cli(["aurora"], last), 1);
    assert.match(last.out.join("\n"), /It is the only theme in this checkout, and the build needs one\./);
  });

  test("what isn't there is an error, not a question", async () => {
    const t = terminal([true]);
    assert.equal(await cli(["app/ghost"], t), 1);
    assert.equal(t.err.join("\n"), "Nothing named ghost is in apps/.");
    assert.equal(await cli(["ghost"], t), 1);
    assert.match(t.err.join("\n"), /Nothing named ghost is in apps\/, connectors\/ or themes\/\.$/);
    assert.deepEqual(t.asked, []);
  });

  test("on its own, lists what can be removed", async () => {
    write("apps/acme/app.json", "{}");
    write("apps/_template/app.json", "{}");
    write("themes/dusk/theme.json", "{}");
    const t = terminal();
    assert.equal(await cli([], t), 0);
    assert.match(t.out.join("\n"), /^Extensions in this checkout:\n {2}app\/acme\n {2}theme\/dusk\n/);
  });
});

// ── shared with npm run register ────────────────────────────────────────────

describe("--recover and --break-lock", () => {
  test("--recover puts back a removal that stopped with the folder in backup", async () => {
    write("apps/acme/app.json", '{"name":"Acme"}');
    const where = backupLocation(root, "app", "acme");
    writeBackupRecord(where.record, {
      operation: "remove",
      kind: "app",
      slug: "acme",
      token: "a-removal-that-stopped-0001",
      pid: 999999,
      hostname: os.hostname(),
      startedAt: "2026-10-11T09:00:00.000Z",
    });
    fs.renameSync(path.join(root, "apps", "acme"), where.folder);

    // While it waits there, removing it again is refused, naming the way out.
    const again = terminal([true]);
    assert.equal(await cli(["app/acme"], again), 1);
    assert.match(again.err.join("\n"), /npm run remove -- --recover/);

    const t = terminal([true]);
    assert.equal(await cli(["--recover"], t), 0, t.err.join("\n"));
    const out = t.out.join("\n");
    assert.match(out, /Found:\n {2}\.mixos\/backup\/apps\/acme\n {4}A removal of acme \(pid 999999 on this machine/);
    assert.match(out, /Recovery will: Move it back to apps\/acme and regenerate the registry\./);
    assert.match(out, /Regenerated the registry\./);
    assert.deepEqual(t.asked, ["Go ahead?"]);
    assert.equal(exists("apps/acme/app.json"), true);
    assert.equal(audit.at(-1)?.action, "app.remove.recover");
  });

  test("--break-lock is the same as npm run register's", async () => {
    const t = terminal();
    assert.equal(await cli(["--break-lock"], t), 0);
    assert.match(t.out.join("\n"), /isn't locked/);
  });
});

// ── git, read-only ──────────────────────────────────────────────────────────

describe("what it asks git", () => {
  test("in a real repository: what isn't committed in the folder, and whether git tracks it", (t) => {
    const env = { PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" } as unknown as NodeJS.ProcessEnv;
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", env });
    if (git("init", "-q").status !== 0) {
      t.skip("git isn't available");
      return;
    }
    write("apps/acme/app.json", "{}");
    write("apps/acme/README.md", "# Acme\n");
    write("apps/other/app.json", "{}");
    git("add", "apps/acme/app.json");
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
    write("apps/acme/app.json", '{"name":"Acme"}');
    assert.deepEqual(uncommittedPaths(root, "apps/acme")?.sort(), ["apps/acme/README.md", "apps/acme/app.json"]);
    assert.deepEqual(uncommittedPaths(root, "apps/other"), ["apps/other/app.json"]);
    assert.equal(trackedByGit(root, "apps/acme"), true);
    assert.equal(trackedByGit(root, "apps/other"), false);
    // Outside a work tree, git can't say.
    assert.equal(uncommittedPaths(tmp, "apps/acme"), null);
  });
});

describe("the script", () => {
  test("npm run remove with an option it doesn't know exits 2, before reaching a database", () => {
    const repo = path.resolve(__dirname, "..");
    const run = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules", "tsx", "dist", "cli.mjs"), path.join(__dirname, "remove.ts"), "--frobnicate"],
      { cwd: path.join(repo, "apps"), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmp } as unknown as NodeJS.ProcessEnv },
    );
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stderr, /Unknown option --frobnicate/);
    assert.match(run.stderr, /npm run remove -- <app\|connector\|theme>\/<slug>/);
  });
});
