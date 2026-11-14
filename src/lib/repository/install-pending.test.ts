/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An install from the Registry, start to finish, in a checkout of its own: an
 * app or a connector lands in `.mixos/pending/`, not in `apps/` or
 * `connectors/`, with its install record, `.registry.json`, in its folder and
 * a sidecar beside it, and both locks are held while it works.
 *
 * The real check runs (the generator's `--check`, as a child). The catalogue
 * and GitHub are a stubbed `fetch`, and the register lock's database a stubbed
 * pool, so nothing leaves the machine and no database is needed. The checkout
 * is a temporary folder whose `scripts/`, `src/` and `node_modules/` link to
 * this repository's, which the check only reads. Register, for a package
 * install left files out of, runs in a second checkout with a stand-in
 * generator.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { TarEntry } from "./tar";
import { TEST_REPOSITORY_KEYS, signedForTest } from "./test-signing";

// ── the checkout ────────────────────────────────────────────────────────────

const REPO = process.cwd();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-install-pending-")));
for (const name of ["scripts", "src", "node_modules"]) {
  fs.symlinkSync(path.join(REPO, name), path.join(root, name));
}
fs.copyFileSync(path.join(REPO, "tsconfig.json"), path.join(root, "tsconfig.json"));
for (const dir of ["apps", "connectors", "themes"]) fs.mkdirSync(path.join(root, dir));

// install.ts reads the checkout from the working directory when it loads, and
// a checkout is not a built deployment.
process.chdir(root);
delete process.env.VERCEL;
for (const flag of ["INSTALL_APPS", "INSTALL_CONNECTORS", "INSTALL_THEMES"]) delete process.env[flag];
process.env.MIXOS_REPOSITORY_URL = "http://127.0.0.1:9";
process.env.MIXOS_REPOSITORY_KEYS = TEST_REPOSITORY_KEYS;

after(() => {
  process.chdir(REPO);
  fs.rmSync(root, { recursive: true, force: true });
});

// Register runs the registry generator, which writes src/generated/, and this
// checkout's src/ is this repository's. So Register runs in a checkout of its
// own, `aside`, with a stand-in that registers every folder in apps/.
const aside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-install-pending-register-")));
for (const dir of ["apps", "connectors"]) fs.mkdirSync(path.join(aside, dir));
const generatorDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-install-pending-generator-")));
const STAND_IN = path.join(generatorDir, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : []);
fs.mkdirSync("src/generated", { recursive: true });
fs.writeFileSync("src/generated/app-registry.ts", JSON.stringify(list("apps").map((slug) => ({ slug })), null, 2));
fs.writeFileSync("src/generated/connector-registry.ts", JSON.stringify(list("connectors").map((name) => ({ name })), null, 2));
`,
);
after(() => {
  fs.rmSync(aside, { recursive: true, force: true });
  fs.rmSync(generatorDir, { recursive: true, force: true });
});

/** Every file under `dir`, by its path there, sorted. */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk("");
  return out.sort();
}

// ── the register lock's database ────────────────────────────────────────────

/** Each statement the lock ran, by its first words. */
const statements: string[] = [];
(globalThis as { __pg?: unknown }).__pg = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push(text.split(" ").slice(0, 3).join(" "));
    if (text.startsWith("insert into public._platform_locks")) return [{ holder: values[1] }];
    if (text.startsWith("update public._platform_locks")) return [{ held: 1 }];
    return [];
  },
  // Register's audit row passes its details through this.
  { json: (value: unknown) => ({ json: value }) },
);

// ── the catalogue and GitHub ────────────────────────────────────────────────

type Kind = "app" | "connector";
const SEGMENT = { app: "apps", connector: "connectors" } as const;

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(`${(type === "5" ? 0o755 : 0o644).toString(8).padStart(7, "0")}\0`, 100, 8, "latin1");
  h.write("0000000\0", 108, 8, "latin1");
  h.write("0000000\0", 116, 8, "latin1");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  h.write("00000000000\0", 136, 12, "latin1");
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, "latin1");
  h.write("ustar\0", 257, 6, "latin1");
  h.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return h;
}

/** A GitHub archive: one root folder holding `entries`. */
function tarball(top: string, entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [header(`${top}/`, 0, "5")];
  for (const e of entries) {
    blocks.push(header(`${top}/${e.path}`, e.data.length, "0"), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const files = (spec: Record<string, string>): TarEntry[] =>
  Object.entries(spec).map(([p, d]) => ({ path: p, mode: 0o644, data: Buffer.from(d) }));

/** The connector template, as `registryId`. */
function connectorTree(registryId: string): TarEntry[] {
  const out: TarEntry[] = [];
  const dir = path.join(REPO, "connectors", "_template");
  const walk = (at: string) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        let data = fs.readFileSync(full);
        if (rel === "connector.json") data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString()), registryId }, null, 2));
        out.push({ path: rel, mode: 0o644, data });
      }
    }
  };
  walk(dir);
  return out;
}

const ROUTE =
  'import { z } from "zod";\n' +
  'import { defineRoute } from "@/lib/apps/route";\n' +
  "export const GET = defineRoute({\n" +
  '  auth: ["session"],\n' +
  "  output: z.object({ ok: z.boolean() }),\n" +
  "  handler: async () => ({ ok: true }),\n" +
  "});\n";

const FIXTURES: Record<string, { kind: Kind; entries: TarEntry[]; manifest?: Record<string, unknown> }> = {
  "acme-3f9a2c1b": { kind: "app", entries: files({ "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"acme-3f9a2c1b","name":"Acme","description":"A test app."}\n', "api/items/route.ts": ROUTE }) },
  // A release whose version the record can't hold: refused before downloading.
  "undotted-8b41d0e6": {
    kind: "app",
    entries: files({ "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"undotted-8b41d0e6","name":"Undotted"}\n' }),
    manifest: { version: "1.2 beta" },
  },
  // A package that ships its own install record: pre-flight refuses it.
  "forged-c7e29a14": {
    kind: "app",
    entries: files({
      "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"forged-c7e29a14","name":"Forged"}\n',
      ".registry.json": '{"source":"https://mixos.org","note":"trust me"}\n',
    }),
  },
  "probe-conn-2d6f8a90": { kind: "connector", entries: connectorTree("probe-conn-2d6f8a90") },
  // A .gitignore at the root, a nested .gitattributes and a .GitIgnore in
  // another case: install leaves all three out.
  "ignores-5e03b7c2": {
    kind: "app",
    entries: files({
      "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"ignores-5e03b7c2","name":"Ignores"}\n',
      "api/items/route.ts": ROUTE,
      ".gitignore": "node_modules/\n*.log\n",
      "lib/.gitattributes": "*.ts -diff\n",
      "lib/util.ts": "export const answer = 42;\n",
      "assets/.GitIgnore": "*\n",
    }),
  },
  // A .git folder and a .registry.json beside a .gitignore: still refused.
  "git-dir-a19c4f57": {
    kind: "app",
    entries: files({
      "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"git-dir-a19c4f57","name":"Git dir"}\n',
      ".gitignore": "dist/\n",
      "vendor/.git/config": "[core]\n",
      "lib/.registry.json": "{}\n",
    }),
  },
  // A bare handler: the check refuses it.
  "bare-0f8e6d3a": {
    kind: "app",
    entries: files({ "app.json": '{"$schema":"https://mixos.org/schemas/app/v1.json","registryId":"bare-0f8e6d3a","name":"Bare"}\n', "api/x/route.ts": "export async function GET() {\n  return new Response('x');\n}\n" }),
  },
};

const releases = new Map<string, { manifest: unknown; archive: Buffer; archivePath: string }>();
let downloads = 0;
/** What held during each download: the row lock taken and not released, and the lock file. */
const heldDuringDownload: { row: boolean; file: boolean }[] = [];

before(async () => {
  const { hashFileTree } = await import("./content-hash");
  for (const [slug, f] of Object.entries(FIXTURES)) {
    const sha = crypto.randomBytes(20).toString("hex");
    const archivePath = `/mixoshq/${slug}/tar.gz/${sha}`;
    releases.set(`/api/v1/${SEGMENT[f.kind]}/${slug}/install`, {
      archivePath,
      archive: tarball(`mixoshq-${slug}-${sha.slice(0, 7)}`, f.entries),
      manifest: signedForTest({
        kind: f.kind,
        slug,
        name: slug,
        version: "1.2.0",
        commitSha: sha,
        gitTag: "v1.2.0",
        tarballUrl: `https://codeload.github.com${archivePath}`,
        contentHash: hashFileTree(f.entries),
        subpath: null,
        permissions: [],
        requiresMixOS: "0.0.1",
        yanked: false,
        ...f.manifest,
      }),
    });
  }

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "127.0.0.1") {
      const release = releases.get(url.pathname);
      return release ? Response.json(release.manifest) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (url.hostname === "codeload.github.com") {
      downloads += 1;
      const inserts = statements.filter((s) => s.startsWith("insert into public._platform_locks")).length;
      const deletes = statements.filter((s) => s.startsWith("delete from public._platform_locks")).length;
      heldDuringDownload.push({ row: inserts > deletes, file: fs.existsSync(path.join(root, ".mixos", "lock")) });
      const release = [...releases.values()].find((r) => r.archivePath === url.pathname);
      return release
        ? new Response(new Uint8Array(release.archive), { headers: { "content-length": String(release.archive.length) } })
        : new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected request to ${url.href}`);
  }) as typeof fetch;
});

const install = () => import("./install");
const pendingModule = () => import("./pending");
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

// ── the tests ───────────────────────────────────────────────────────────────

describe("an install from the Registry", { concurrency: false }, () => {
  test("puts an app in .mixos/pending/, not apps/, with its install record inside and its sidecar beside it", async () => {
    const { installExtension } = await install();
    const { readSidecar, pendingLocation } = await pendingModule();
    const { folderFilesHash, readInstallRecord } = await import("./install-record");
    const { filesHash, hashFileTree } = await import("./content-hash");
    const started = Date.now();

    const result = await installExtension("app", "acme-3f9a2c1b", { installedBy: "admin@example.com" });

    assert.equal(result.pending, true);
    assert.equal(result.installPath, ".mixos/pending/apps/acme-3f9a2c1b");
    assert.equal(result.registry, null);
    assert.equal(result.handBack, null);
    assert.match(result.nextStep, /npm run register -- app\/acme-3f9a2c1b/);
    assert.equal(exists("apps/acme-3f9a2c1b"), false, "an app must not land in apps/ at install");

    // The record: what was verified, and where it came from, from the
    // catalogue's answer and the download URL that was verified.
    const where = pendingLocation(root, "app", "acme-3f9a2c1b");
    const entries = FIXTURES["acme-3f9a2c1b"].entries;
    const release = releases.get("/api/v1/apps/acme-3f9a2c1b/install")!.manifest as { commitSha: string };
    const record = {
      source: "http://127.0.0.1:9",
      kind: "app",
      slug: "acme-3f9a2c1b",
      version: "1.2.0",
      gitTag: "v1.2.0",
      commitSha: release.commitSha,
      contentHash: hashFileTree(entries),
      filesHash: filesHash(entries),
      repository: { owner: "mixoshq", name: "acme-3f9a2c1b", subpath: null },
      requiresMixOS: "0.0.1",
    };
    assert.deepEqual(readInstallRecord(where.folder), { state: "ok", record });
    assert.deepEqual(result.record, record);

    // The sidecar: only what is about this pending install.
    const read = readSidecar(where.sidecar);
    assert.equal(read.state, "ok");
    const sidecar = read.state === "ok" ? read.sidecar : null;
    assert.deepEqual(
      { ...sidecar, installedAt: undefined },
      {
        kind: "app",
        slug: "acme-3f9a2c1b",
        yankedAccepted: false,
        installedAt: undefined,
        installedBy: "admin@example.com",
        check: { verdict: "accepted", deferred: [] },
      },
    );
    assert.ok(Date.parse(sidecar!.installedAt) >= started - 1000);
    // What Register will recompute from the folder, the record left out.
    assert.equal(folderFilesHash(where.folder), record.filesHash);
    assert.equal(result.filesHash, record.filesHash);
    // The package's files, as counted for the audit row.
    assert.equal(result.fileCount, 2);
    for (const f of ["app.json", "api/items/route.ts", ".registry.json"]) {
      assert.equal(fs.statSync(path.join(where.folder, f)).mode & 0o111, 0);
    }

    // Nothing left behind: no staged copy, no lock.
    assert.deepEqual(fs.readdirSync(path.join(root, ".mixos", "staging", "apps")), []);
    assert.equal(exists(".mixos/lock"), false);
  });

  test("held the register lock and the checkout lock while it worked, and released both", () => {
    assert.ok(heldDuringDownload.length >= 1);
    assert.deepEqual(heldDuringDownload[0], { row: true, file: true });
    const inserts = statements.filter((s) => s.startsWith("insert into public._platform_locks")).length;
    const deletes = statements.filter((s) => s.startsWith("delete from public._platform_locks")).length;
    assert.equal(inserts, deletes);
  });

  test("refuses the same slug while it is pending, before downloading anything", async () => {
    const { installExtension, InstallError } = await install();
    const before = downloads;
    await assert.rejects(
      installExtension("app", "acme-3f9a2c1b"),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === "already-installed" &&
        /waiting in \.mixos\/pending\/apps\/acme-3f9a2c1b\//.test(err.message) &&
        /Register or discard it in Admin > Apps/.test(err.message) &&
        /npm run register -- app\/acme-3f9a2c1b --discard/.test(err.message),
    );
    assert.equal(downloads, before);
  });

  test("puts a connector in pending too", async () => {
    const { installExtension } = await install();
    const result = await installExtension("connector", "probe-conn-2d6f8a90", { installedBy: "admin@example.com" });
    assert.equal(result.pending, true);
    assert.equal(result.installPath, ".mixos/pending/connectors/probe-conn-2d6f8a90");
    assert.equal(exists("connectors/probe-conn-2d6f8a90"), false);
    assert.equal(exists(".mixos/pending/connectors/probe-conn-2d6f8a90/connector.json"), true);
    assert.equal(exists(".mixos/pending/connectors/probe-conn-2d6f8a90/.registry.json"), true);
    assert.equal(exists(".mixos/pending/connectors/probe-conn-2d6f8a90.json"), true);
    assert.equal(result.record.kind, "connector");
  });

  test("leaves out a .gitignore and a .gitattributes at any depth, in any case, and hashes what it wrote", async () => {
    const { installExtension } = await install();
    const { readSidecar, pendingLocation } = await pendingModule();
    const { folderFilesHash, readInstallRecord } = await import("./install-record");
    const { filesHash, hashFileTree } = await import("./content-hash");

    const result = await installExtension("app", "ignores-5e03b7c2", { installedBy: "admin@example.com" });
    const where = pendingLocation(root, "app", "ignores-5e03b7c2");

    // None of the three is written, nor assets/, which held only one of them.
    assert.deepEqual(filesIn(where.folder), [".registry.json", "api/items/route.ts", "app.json", "lib/util.ts"]);
    assert.equal(fs.existsSync(path.join(where.folder, "assets")), false);
    assert.deepEqual(result.leftOut, { ".gitignore": 2, ".gitattributes": 1 });
    assert.equal(result.fileCount, 3);

    // The content hash is the package's as published, the three included, and
    // it was verified before they were left out. The files hash is over what
    // was written, which is what the folder recomputes.
    const all = FIXTURES["ignores-5e03b7c2"].entries;
    const written = all.filter((e) => !/(^|\/)\.git(ignore|attributes)$/i.test(e.path));
    assert.equal(written.length, 3);
    const read = readInstallRecord(where.folder);
    assert.equal(read.state, "ok");
    const record = read.state === "ok" ? read.record : null;
    assert.equal(record?.contentHash, hashFileTree(all));
    assert.equal(record?.filesHash, filesHash(written));
    assert.notEqual(record?.filesHash, filesHash(all));
    assert.equal(folderFilesHash(where.folder), record?.filesHash);
    assert.equal(result.filesHash, record?.filesHash);

    // The sidecar keeps what was left out, for Register to say again.
    const sidecar = readSidecar(where.sidecar);
    assert.deepEqual(sidecar.state === "ok" && sidecar.sidecar.leftOut, { ".gitignore": 2, ".gitattributes": 1 });
  });

  test("Register's files hash check passes for it, and the generator finds it unmodified", async () => {
    const { registerPending } = await import("./register");
    const { pendingLocation } = await pendingModule();
    const { scanRegistryInstalls } = await import("../../../scripts/generate-project-registry");

    // What install left in pending, moved as it is into the other checkout.
    const from = pendingLocation(root, "app", "ignores-5e03b7c2");
    const to = pendingLocation(aside, "app", "ignores-5e03b7c2");
    fs.mkdirSync(path.dirname(to.folder), { recursive: true });
    fs.cpSync(from.folder, to.folder, { recursive: true });
    fs.copyFileSync(from.sidecar, to.sidecar);

    const result = await registerPending("app", "ignores-5e03b7c2", {
      actor: { id: null, email: "cli:tester@test-host" },
      via: "cli",
      root: aside,
      generator: STAND_IN,
      notice: () => {},
    });
    assert.equal(result.installPath, "apps/ignores-5e03b7c2");
    assert.deepEqual(result.leftOut, { ".gitignore": 2, ".gitattributes": 1 });
    const live = path.join(aside, "apps", "ignores-5e03b7c2");
    assert.deepEqual(filesIn(live), [".registry.json", "api/items/route.ts", "app.json", "lib/util.ts"]);

    // The generator's check, as it runs on every build.
    const { installs, warnings } = scanRegistryInstalls([{ kind: "app", slug: "ignores-5e03b7c2", dir: live }]);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].modified, false);
    assert.deepEqual(
      warnings.filter((w) => /no longer matches|differs from/.test(w)),
      [],
    );
  });

  test("a .git and a .registry.json are still refused beside a .gitignore, with nothing written", async () => {
    const { installExtension, InstallError } = await install();
    await assert.rejects(
      installExtension("app", "git-dir-a19c4f57"),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === "invalid-package" &&
        /^"vendor\/\.git" makes git treat the folder it is in as a repository of its own/m.test(err.detail ?? "") &&
        /^"lib\/\.registry\.json" is named like the install record/m.test(err.detail ?? "") &&
        (err.detail ?? "").split("\n").length === 2,
    );
    assert.equal(exists(".mixos/pending/apps/git-dir-a19c4f57"), false);
    assert.equal(exists(".mixos/pending/apps/git-dir-a19c4f57.json"), false);
    assert.deepEqual(fs.readdirSync(path.join(root, ".mixos", "staging", "apps")), []);
  });

  test("a release whose answer the record can't hold is refused before anything is downloaded", async () => {
    const { installExtension, InstallError } = await install();
    const before = downloads;
    await assert.rejects(
      installExtension("app", "undotted-8b41d0e6"),
      (err: unknown) => err instanceof InstallError && err.code === "invalid-package" && /version: /.test(err.message),
    );
    assert.equal(downloads, before);
    assert.equal(exists(".mixos/pending/apps/undotted-8b41d0e6"), false);
  });

  test("a package that ships its own .registry.json is refused by pre-flight, with nothing written", async () => {
    const { installExtension, InstallError } = await install();
    await assert.rejects(
      installExtension("app", "forged-c7e29a14"),
      (err: unknown) =>
        err instanceof InstallError && err.code === "invalid-package" && /named like the install record/.test(err.detail ?? ""),
    );
    assert.equal(exists(".mixos/pending/apps/forged-c7e29a14"), false);
    assert.deepEqual(fs.readdirSync(path.join(root, ".mixos", "staging", "apps")), []);
  });

  test("a package the check refuses leaves nothing in pending or staging", async () => {
    const { installExtension, InstallError } = await install();
    await assert.rejects(
      installExtension("app", "bare-0f8e6d3a"),
      (err: unknown) => err instanceof InstallError && err.code === "rejected-by-registry" && /api\/x\/route\.ts/.test(err.detail ?? ""),
    );
    assert.equal(exists(".mixos/pending/apps/bare-0f8e6d3a"), false);
    assert.equal(exists(".mixos/pending/apps/bare-0f8e6d3a.json"), false);
    assert.deepEqual(fs.readdirSync(path.join(root, ".mixos", "staging", "apps")), []);
    assert.equal(exists("apps/bare-0f8e6d3a"), false);
  });

  test("refuses a slug whose removal stopped midway, before downloading anything", async () => {
    const { installExtension, InstallError } = await install();
    const { backupLocation } = await import("./backup");
    const where = backupLocation(root, "app", "probe-app-6c2d8e10");
    fs.mkdirSync(where.folder, { recursive: true });
    const before = downloads;
    try {
      await assert.rejects(
        installExtension("app", "probe-app-6c2d8e10"),
        (err: unknown) =>
          err instanceof InstallError &&
          err.code === "already-installed" &&
          /A removal of probe-app-6c2d8e10 stopped before it finished, and left \.mixos\/backup\/apps\/probe-app-6c2d8e10\./.test(err.message) &&
          /npm run remove -- --recover/.test(err.message),
      );
    } finally {
      fs.rmSync(where.folder, { recursive: true, force: true });
    }
    assert.equal(downloads, before);
  });

  test("is refused while another process holds the checkout lock, naming it, before downloading", async () => {
    const { installExtension } = await install();
    const { tryAcquireCheckoutLock, CheckoutLockHeldError } = await import("../platform/checkout-lock");
    const held = tryAcquireCheckoutLock(root, "the registry generator");
    const before = downloads;
    try {
      await assert.rejects(
        installExtension("app", "acme-3f9a2c1b"),
        (err: unknown) => err instanceof CheckoutLockHeldError && /locked by the registry generator/.test(err.message),
      );
    } finally {
      held.release();
    }
    assert.equal(downloads, before);
  });
});
