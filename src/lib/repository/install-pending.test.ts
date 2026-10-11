/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An install from the Registry, start to finish, in a checkout of its own: an
 * app or a connector lands in `.mixos/pending/`, not in `apps/` or
 * `connectors/`, with a sidecar recording what was verified, and both locks are
 * held while it works.
 *
 * The real check runs (the generator's `--check`, as a child). The catalogue
 * and GitHub are a stubbed `fetch`, and the register lock's database a stubbed
 * pool, so nothing leaves the machine and no database is needed. The checkout
 * is a temporary folder whose `scripts/`, `src/` and `node_modules/` link to
 * this repository's, which the check only reads.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { TarEntry } from "./tar";

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

after(() => {
  process.chdir(REPO);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── the register lock's database ────────────────────────────────────────────

/** Each statement the lock ran, by its first words. */
const statements: string[] = [];
(globalThis as { __pg?: unknown }).__pg = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  statements.push(text.split(" ").slice(0, 3).join(" "));
  if (text.startsWith("insert into public._platform_locks")) return [{ holder: values[1] }];
  if (text.startsWith("update public._platform_locks")) return [{ held: 1 }];
  return [];
};

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

/** The connector template, renamed. */
function connectorTree(name: string): TarEntry[] {
  const out: TarEntry[] = [];
  const dir = path.join(REPO, "connectors", "_template");
  const walk = (at: string) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        let data = fs.readFileSync(full);
        if (rel === "connector.json") data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString()), name }, null, 2));
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

const FIXTURES: Record<string, { kind: Kind; entries: TarEntry[] }> = {
  acme: { kind: "app", entries: files({ "app.json": '{"name":"Acme","description":"A test app."}\n', "api/items/route.ts": ROUTE }) },
  "probe-conn": { kind: "connector", entries: connectorTree("probe-conn") },
  // A bare handler: the check refuses it.
  bare: {
    kind: "app",
    entries: files({ "app.json": '{"name":"Bare"}\n', "api/x/route.ts": "export async function GET() {\n  return new Response('x');\n}\n" }),
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
      manifest: {
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
        requiresMixOS: null,
        yanked: false,
      },
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
  test("puts an app in .mixos/pending/, not apps/, with a sidecar of what was verified", async () => {
    const { installExtension } = await install();
    const { folderFilesHash, readSidecar, pendingLocation } = await pendingModule();
    const { filesHash, hashFileTree } = await import("./content-hash");
    const started = Date.now();

    const result = await installExtension("app", "acme", { installedBy: "admin@example.com" });

    assert.equal(result.pending, true);
    assert.equal(result.installPath, ".mixos/pending/apps/acme");
    assert.equal(result.registry, null);
    assert.match(result.nextStep, /npm run register -- app\/acme/);
    assert.equal(exists("apps/acme"), false, "an app must not land in apps/ at install");

    const where = pendingLocation(root, "app", "acme");
    const read = readSidecar(where.sidecar);
    assert.equal(read.state, "ok");
    const sidecar = read.state === "ok" ? read.sidecar : null;
    const entries = FIXTURES.acme.entries;
    assert.deepEqual(
      { ...sidecar, installedAt: undefined },
      {
        kind: "app",
        slug: "acme",
        source: "http://127.0.0.1:9",
        version: "1.2.0",
        gitTag: "v1.2.0",
        commitSha: (releases.get("/api/v1/apps/acme/install")!.manifest as { commitSha: string }).commitSha,
        contentHash: hashFileTree(entries),
        filesHash: filesHash(entries),
        requiresMixOS: null,
        yankedAccepted: false,
        installedAt: undefined,
        installedBy: "admin@example.com",
        fileCount: 2,
        byteCount: entries.reduce((n, e) => n + e.data.length, 0),
        check: { verdict: "accepted", deferred: [] },
      },
    );
    assert.ok(Date.parse(sidecar!.installedAt) >= started - 1000);
    // What Register will recompute from the folder.
    assert.equal(folderFilesHash(where.folder), sidecar!.filesHash);
    assert.equal(result.filesHash, sidecar!.filesHash);
    for (const f of ["app.json", "api/items/route.ts"]) {
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
      installExtension("app", "acme"),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === "already-installed" &&
        /waiting in \.mixos\/pending\/apps\/acme\//.test(err.message) &&
        /Register or discard it in Admin > Apps/.test(err.message) &&
        /npm run register -- app\/acme --discard/.test(err.message),
    );
    assert.equal(downloads, before);
  });

  test("puts a connector in pending too", async () => {
    const { installExtension } = await install();
    const result = await installExtension("connector", "probe-conn", { installedBy: "admin@example.com" });
    assert.equal(result.pending, true);
    assert.equal(result.installPath, ".mixos/pending/connectors/probe-conn");
    assert.equal(exists("connectors/probe-conn"), false);
    assert.equal(exists(".mixos/pending/connectors/probe-conn/connector.json"), true);
    assert.equal(exists(".mixos/pending/connectors/probe-conn.json"), true);
  });

  test("a package the check refuses leaves nothing in pending or staging", async () => {
    const { installExtension, InstallError } = await install();
    await assert.rejects(
      installExtension("app", "bare"),
      (err: unknown) => err instanceof InstallError && err.code === "rejected-by-registry" && /api\/x\/route\.ts/.test(err.detail ?? ""),
    );
    assert.equal(exists(".mixos/pending/apps/bare"), false);
    assert.equal(exists(".mixos/pending/apps/bare.json"), false);
    assert.deepEqual(fs.readdirSync(path.join(root, ".mixos", "staging", "apps")), []);
    assert.equal(exists("apps/bare"), false);
  });

  test("is refused while another process holds the checkout lock, naming it, before downloading", async () => {
    const { installExtension } = await install();
    const { tryAcquireCheckoutLock, CheckoutLockHeldError } = await import("../platform/checkout-lock");
    const held = tryAcquireCheckoutLock(root, "the registry generator");
    const before = downloads;
    try {
      await assert.rejects(
        installExtension("app", "acme"),
        (err: unknown) => err instanceof CheckoutLockHeldError && /locked by the registry generator/.test(err.message),
      );
    } finally {
      held.release();
    }
    assert.equal(downloads, before);
  });
});
