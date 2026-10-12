/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An update, start to finish, in a checkout of its own: install's update mode
 * (./install.ts), the update dialog's work (./update-admin.ts), and Register
 * and Discard on the pending update it leaves (./register.ts).
 *
 * The check is a stand-in that accepts, run as install runs the generator's
 * `--check`, as a child that writes its verdict to a file: an update checks a
 * release exactly as an install does, and ./install-pending.test.ts runs the
 * real check. The catalogue and GitHub are a stubbed `fetch`, and the database
 * a stubbed pool that answers the register lock and keeps the audit rows, so
 * nothing leaves the machine. The checkout is a temporary folder whose `src/`
 * and `node_modules/` link to this repository's. The extensions "in place" are
 * written there as install and Register leave them: the release's files and an
 * install record.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AdminActor } from "../apps/admin-audit";
// Neither reads the working directory when it loads, unlike ./install.ts,
// which is imported once the checkout is the working directory.
import { filesHash } from "./content-hash";
import { serializeInstallRecord } from "./install-record";
import type { TarEntry } from "./tar";

// ── the checkout ────────────────────────────────────────────────────────────

const REPO = process.cwd();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-install-update-")));
for (const name of ["src", "node_modules"]) {
  fs.symlinkSync(path.join(REPO, name), path.join(root, name));
}
fs.copyFileSync(path.join(REPO, "tsconfig.json"), path.join(root, "tsconfig.json"));
// The generator, as far as an update's check needs it: a verdict that accepts,
// in the file install names.
fs.mkdirSync(path.join(root, "scripts"));
fs.writeFileSync(
  path.join(root, "scripts", "generate-project-registry.ts"),
  `import fs from "node:fs";
const args = process.argv.slice(2);
const at = args.indexOf("--verdict-file");
if (args[0] !== "--check" || at < 0) process.exit(2);
fs.writeFileSync(args[at + 1], JSON.stringify({ verdict: "accepted", problems: [], deferred: [] }) + "\\n");
`,
);
for (const dir of ["apps", "connectors", "themes"]) fs.mkdirSync(path.join(root, dir));

// install.ts reads the checkout from the working directory when it loads, and
// a checkout is not a built deployment.
process.chdir(root);
delete process.env.VERCEL;
for (const flag of ["INSTALL_APPS", "INSTALL_CONNECTORS", "INSTALL_THEMES"]) delete process.env[flag];
const CATALOGUE = "http://127.0.0.1:9";
process.env.MIXOS_REPOSITORY_URL = CATALOGUE;

after(() => {
  process.chdir(REPO);
  fs.rmSync(root, { recursive: true, force: true });
});

const exists = (rel: string) => fs.existsSync(path.join(root, rel));

// ── the database ────────────────────────────────────────────────────────────

interface AuditRow {
  actor_email: unknown;
  action: string;
  target_id: unknown;
  details: Record<string, unknown>;
}
const audit: AuditRow[] = [];
(globalThis as { __pg?: unknown }).__pg = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert into public._platform_locks")) return [{ holder: values[1] }];
    if (text.startsWith("update public._platform_locks")) return [{ held: 1 }];
    if (text.startsWith("insert into public.admin_audit_log")) {
      audit.push({
        actor_email: values[1],
        action: values[2] as string,
        target_id: values[4],
        details: (values[5] as { json: Record<string, unknown> }).json,
      });
    }
    return [];
  },
  { json: (value: unknown) => ({ json: value }) },
);
const rows = (action: string) => audit.filter((r) => r.action === action);

// ── the catalogue and GitHub ────────────────────────────────────────────────

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

const ROUTE =
  'import { z } from "zod";\n' +
  'import { defineRoute } from "@/lib/apps/route";\n' +
  "export const GET = defineRoute({\n" +
  '  auth: ["session"],\n' +
  "  output: z.object({ ok: z.boolean() }),\n" +
  "  handler: async () => ({ ok: true }),\n" +
  "});\n";

const app = (manifest: Record<string, unknown>, extra: Record<string, string> = {}): TarEntry[] =>
  files({ "app.json": `${JSON.stringify(manifest, null, 2)}\n`, "api/items/route.ts": ROUTE, ...extra });

interface ReleaseFixture {
  /** Dotted, or null for a website release, named by its commit. */
  version: string | null;
  releasedAt: string;
  entries: TarEntry[];
  permissions?: { scope: string; reason: string }[];
  yankedReason?: string;
}

const BOARD_1_2 = app(
  { name: "Board", description: "A board.", egress: ["api.example.com"], database: true },
  { "migrations/0001_items.sql": "create table items (id bigint primary key);\n", "README.md": "# Board\n" },
);
const BOARD_1_3 = app(
  {
    name: "Board",
    description: "A board.",
    egress: ["api.example.com", "files.example.com"],
    env: [{ key: "BOARD_TOKEN", label: "Token", type: "password" }],
    database: true,
  },
  {
    "migrations/0001_items.sql": "create table items (id bigint primary key);\n",
    "migrations/0002_tags.sql": "create table tags (id bigint primary key);\n",
    "README.md": "# Board\n\nNow with tags.\n",
  },
);
const NOTES_OLD = app(
  { name: "Notes", description: "Notes.", database: true },
  { "migrations/0001_notes.sql": "create table notes (id bigint primary key);\n" },
);
const NOTES_NEW = app(
  { name: "Notes", description: "Notes.", database: true },
  {
    "migrations/0001_notes.sql": "create table notes (id bigint primary key);\n",
    "migrations/0002_pins.sql": "create table pins (id bigint primary key);\n",
  },
);

const READS = { scope: "network:api.example.com", reason: "Reads items." };
const LISTINGS: Record<string, { latest: number; releases: ReleaseFixture[] }> = {
  board: {
    latest: 1,
    releases: [
      { version: "1.4.0", releasedAt: "2026-10-10T12:00:00Z", entries: BOARD_1_3, yankedReason: "Corrupts boards.", permissions: [READS] },
      {
        version: "1.3.0",
        releasedAt: "2026-10-08T12:00:00Z",
        entries: BOARD_1_3,
        permissions: [READS, { scope: "network:files.example.com", reason: "Uploads attachments." }],
      },
      { version: "1.2.0", releasedAt: "2026-10-01T12:00:00Z", entries: BOARD_1_2, permissions: [READS] },
    ],
  },
  notes: {
    latest: 0,
    releases: [
      { version: null, releasedAt: "2026-10-09T12:00:00Z", entries: NOTES_NEW },
      { version: null, releasedAt: "2026-10-01T12:00:00Z", entries: NOTES_OLD },
    ],
  },
};

/** Each release as the catalogue answers for it, by slug and version. */
interface Published {
  slug: string;
  version: string;
  gitTag: string | null;
  commitSha: string;
  contentHash: string;
  releasedAt: string;
  archivePath: string;
  archive: Buffer;
  entries: TarEntry[];
  permissions: { scope: string; reason: string }[];
  yankedReason?: string;
}
const published = new Map<string, Published[]>();
const release = (slug: string, version: string) => published.get(slug)!.find((r) => r.version === version)!;
/** Archives GitHub stops serving, by path. */
const withheld = new Set<string>();
const downloads: string[] = [];

before(async () => {
  const { hashFileTree } = await import("./content-hash");
  for (const [slug, listing] of Object.entries(LISTINGS)) {
    published.set(
      slug,
      listing.releases.map((r) => {
        const commitSha = crypto.randomBytes(20).toString("hex");
        const archivePath = `/mixoshq/${slug}/tar.gz/${commitSha}`;
        return {
          slug,
          version: r.version ?? commitSha.slice(0, 7),
          gitTag: r.version ? `v${r.version}` : null,
          commitSha,
          contentHash: hashFileTree(r.entries),
          releasedAt: r.releasedAt,
          archivePath,
          archive: tarball(`mixoshq-${slug}-${commitSha.slice(0, 7)}`, r.entries),
          entries: r.entries,
          permissions: r.permissions ?? [],
          yankedReason: r.yankedReason,
        };
      }),
    );
  }

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host === "127.0.0.1:9") {
      const [, , , , slug, install] = url.pathname.split("/");
      const releases = published.get(slug);
      if (!releases) return Response.json({ error: "not found" }, { status: 404 });
      const latest = releases[LISTINGS[slug].latest];
      if (install === "install") {
        const r = url.searchParams.get("version") ? releases.find((x) => x.version === url.searchParams.get("version")) : latest;
        if (!r) return Response.json({ error: "unknown version" }, { status: 404 });
        return Response.json({
          kind: "app",
          slug,
          name: slug === "board" ? "Board" : "Notes",
          version: r.version,
          commitSha: r.commitSha,
          gitTag: r.gitTag,
          tarballUrl: `https://codeload.github.com${r.archivePath}`,
          contentHash: r.contentHash,
          subpath: null,
          permissions: r.permissions,
          requiresMixOS: "0.0.1",
          yanked: r.yankedReason !== undefined,
          yankedReason: r.yankedReason ?? null,
        });
      }
      return Response.json({
        slug,
        kind: "app",
        name: slug === "board" ? "Board" : "Notes",
        author: { handle: "mixoshq" },
        latestVersion: latest.version,
        sourceRepo: { host: "github", owner: "mixoshq", name: slug, url: `https://github.com/mixoshq/${slug}` },
        releases: releases.map((r) => ({
          version: r.version,
          gitTag: r.gitTag,
          commitSha: r.commitSha,
          contentHash: r.contentHash,
          releasedAt: r.releasedAt,
          requiresMixOS: "0.0.1",
          yanked: r.yankedReason !== undefined,
          yankedReason: r.yankedReason ?? null,
        })),
      });
    }
    if (url.hostname === "codeload.github.com") {
      downloads.push(url.pathname);
      const r = [...published.values()].flat().find((x) => x.archivePath === url.pathname);
      return r && !withheld.has(url.pathname)
        ? new Response(new Uint8Array(r.archive), { headers: { "content-length": String(r.archive.length) } })
        : new Response("not found", { status: 404 });
    }
    throw new Error(`unexpected request to ${url.href}`);
  }) as typeof fetch;

  // In place, as install and Register leave them: board 1.2.0, and notes at
  // its newer website release.
  place("board", release("board", "1.2.0"));
  place("notes", published.get("notes")![0]);
});

/** Write a release into apps/<slug>/ with its install record, as Register leaves it. */
function place(slug: string, r: Published, source = CATALOGUE): void {
  const dir = path.join(root, "apps", slug);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const e of r.entries) {
    fs.mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, e.path), e.data, { mode: 0o644 });
  }
  fs.writeFileSync(
    path.join(dir, ".registry.json"),
    serializeInstallRecord({
      source,
      kind: "app",
      slug,
      version: r.version,
      gitTag: r.gitTag,
      commitSha: r.commitSha,
      contentHash: r.contentHash,
      filesHash: filesHash(r.entries),
      repository: { owner: "mixoshq", name: slug, subpath: null },
      requiresMixOS: "0.0.1",
    }),
  );
}

/** Delete a pending update as Discard would, without the audit row. */
function clearPending(slug: string): void {
  fs.rmSync(path.join(root, ".mixos/pending/apps", slug), { recursive: true, force: true });
  fs.rmSync(path.join(root, `.mixos/pending/apps/${slug}.json`), { force: true });
}

const install = () => import("./install");
const ADMIN: AdminActor = { id: "11111111-2222-3333-4444-555555555555", email: "admin@example.com" };
const BOARD_README = path.join(root, "apps/board/README.md");

// ── install's update mode ───────────────────────────────────────────────────

describe("an update", { concurrency: false }, () => {
  test("waits in pending with what it replaces, and leaves the folder in place as it was", async () => {
    const { installExtension } = await install();
    const { folderFilesHash } = await import("./install-record");
    const { pendingLocation, readSidecar } = await import("./pending");
    const before = folderFilesHash(path.join(root, "apps/board"));
    const from = release("board", "1.2.0");

    const result = await installExtension("app", "board", { version: "1.3.0", installedBy: ADMIN.email, update: {} });

    assert.equal(result.pending, true);
    assert.equal(result.installPath, ".mixos/pending/apps/board");
    assert.equal(result.version, "1.3.0");
    const replaces = {
      version: "1.2.0",
      gitTag: "v1.2.0",
      commitSha: from.commitSha,
      filesHash: filesHash(from.entries),
      folderHash: filesHash(from.entries),
      localChangesDiscarded: false,
      direction: "newer",
    };
    assert.deepEqual(result.replaces, replaces);
    assert.match(result.nextStep, /can't register updates yet/);
    assert.match(result.nextStep, /npm run register -- app\/board --discard/);

    // The folder in place, untouched; the new release, with its record, in pending.
    assert.equal(folderFilesHash(path.join(root, "apps/board")), before);
    const where = pendingLocation(root, "app", "board");
    assert.equal(fs.readFileSync(path.join(where.folder, "migrations/0002_tags.sql"), "utf8").startsWith("create"), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(where.folder, ".registry.json"), "utf8")).version, "1.3.0");
    const sidecar = readSidecar(where.sidecar);
    assert.equal(sidecar.state, "ok");
    assert.deepEqual(sidecar.state === "ok" && sidecar.sidecar.replaces, replaces);
    assert.equal(exists(".mixos/lock"), false);
  });

  test("Register refuses the pending update, saying to discard it, and moves nothing", async () => {
    const { registerPending, RegisterError } = await import("./register");
    const { folderFilesHash } = await import("./install-record");
    const before = folderFilesHash(path.join(root, "apps/board"));
    await assert.rejects(
      registerPending("app", "board", { actor: { id: null, email: "cli:tester@test-host" }, via: "cli", notice: () => {} }),
      (err: unknown) =>
        err instanceof RegisterError &&
        err.code === "update-pending" &&
        err.message ===
          ".mixos/pending/apps/board/ is an update of apps/board from 1.2.0 to 1.3.0, and this version of MixOS " +
            "can't register updates yet. Discard it with `npm run register -- app/board --discard`.",
    );
    assert.equal(folderFilesHash(path.join(root, "apps/board")), before);
    assert.equal(exists(".mixos/pending/apps/board/app.json"), true);
    const [row] = rows("app.register.rejected");
    assert.equal(row.details.reason, "update-pending");
    assert.match(String(row.details.message), /can't register updates yet/);
  });

  test("the pending list and the review say the same, and offer only Discard", async () => {
    const { listPendingInstalls } = await import("./pending");
    const { reviewPendingInstall } = await import("./review");
    const said =
      "It is an update of apps/board from 1.2.0 to 1.3.0, and this version of MixOS can't register updates yet. " +
      "Discard it with `npm run register -- app/board --discard`.";
    const listed = listPendingInstalls(root).find((p) => p.slug === "board");
    assert.equal(listed?.problem, said);
    assert.equal(listed?.sidecar?.replaces?.version, "1.2.0");
    assert.equal(reviewPendingInstall(root, "app", "board").problem, said);
  });

  test("an install of the same slug is still refused, as is a second update while one waits", async () => {
    const { installExtension, InstallError } = await install();
    await assert.rejects(
      installExtension("app", "board"),
      (err: unknown) => err instanceof InstallError && err.code === "already-installed" && /apps\/board already exists/.test(err.message),
    );
    await assert.rejects(
      installExtension("app", "board", { version: "1.3.0", update: {} }),
      (err: unknown) => err instanceof InstallError && err.code === "already-installed" && /waiting in \.mixos\/pending\/apps\/board\//.test(err.message),
    );
  });

  test("Discard clears it and keeps the folder in place, and its row says what it would have replaced", async () => {
    const { discardPending } = await import("./register");
    const result = await discardPending("app", "board", { actor: ADMIN, via: "button", notice: () => {} });
    assert.equal(result.pendingPath, ".mixos/pending/apps/board");
    assert.equal(exists(".mixos/pending/apps/board"), false);
    assert.equal(exists(".mixos/pending/apps/board.json"), false);
    assert.equal(exists("apps/board/app.json"), true);
    const [row] = rows("app.discard");
    assert.deepEqual(row.details.replaces, { version: "1.2.0", commitSha: release("board", "1.2.0").commitSha });
  });

  test("local edits are found from the files hash, with nothing downloaded, and have to be discarded", async () => {
    const { installExtension, InstallError } = await install();
    fs.writeFileSync(BOARD_README, "# Board, edited here\n");
    try {
      const before = downloads.length;
      await assert.rejects(
        installExtension("app", "board", { version: "1.3.0", update: {} }),
        (err: unknown) =>
          err instanceof InstallError &&
          err.code === "local-changes" &&
          err.message ===
            "apps/board has changed since 1.2.0 was installed: its files no longer match its install record. " +
              "An update replaces them, so it has to be told to discard those changes.",
      );
      assert.equal(downloads.length, before, "nothing is downloaded to find local edits");

      const result = await installExtension("app", "board", {
        version: "1.3.0",
        update: { discardLocalChanges: true },
      });
      assert.equal(result.replaces?.localChangesDiscarded, true);
      assert.notEqual(result.replaces?.folderHash, result.replaces?.filesHash);
      // Discarding is Register's to do: the edit is still there.
      assert.equal(fs.readFileSync(BOARD_README, "utf8"), "# Board, edited here\n");
    } finally {
      clearPending("board");
      fs.writeFileSync(BOARD_README, "# Board\n");
    }
  });

  test("a downgrade between website releases is told by their dates, and needs Install an older release", async () => {
    const { installExtension, InstallError } = await install();
    const [installed, older] = published.get("notes")!;
    const before = downloads.length;
    await assert.rejects(
      installExtension("app", "notes", { version: older.version, update: {} }),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === "older-release" &&
        err.message ===
          `${older.version} is older than ${installed.version}, which apps/notes runs. Installing an older ` +
            "release has to be chosen explicitly.",
    );
    assert.equal(downloads.length, before, "refused before anything is downloaded");
    const result = await installExtension("app", "notes", { version: older.version, update: { allowOlder: true } });
    assert.equal(result.replaces?.direction, "older");
    assert.equal(result.replaces?.version, installed.version);
    clearPending("notes");
  });

  test("a withdrawn release is refused unless accepted", async () => {
    const { installExtension, InstallError } = await install();
    await assert.rejects(
      installExtension("app", "board", { version: "1.4.0", update: {} }),
      (err: unknown) => err instanceof InstallError && err.code === "yanked" && /Corrupts boards\./.test(err.message),
    );
    const result = await installExtension("app", "board", { version: "1.4.0", allowYanked: true, update: {} });
    assert.equal(result.replaces?.direction, "newer");
    clearPending("board");
  });

  test("what the admin reviewed is pinned: the release and the folder", async () => {
    const { installExtension, InstallError } = await install();
    const from = release("board", "1.2.0");
    const to = release("board", "1.3.0");
    const reviewed = {
      installedCommit: from.commitSha,
      installedFilesHash: filesHash(from.entries),
      folderHash: filesHash(from.entries),
      targetCommit: to.commitSha,
      targetContentHash: to.contentHash,
    };
    await assert.rejects(
      installExtension("app", "board", { version: "1.3.0", update: { reviewed: { ...reviewed, targetCommit: "f".repeat(40) } } }),
      (err: unknown) =>
        err instanceof InstallError && err.code === "changed-meanwhile" && /now lists another commit or checksum for 1\.3\.0/.test(err.message),
    );
    await assert.rejects(
      installExtension("app", "board", { version: "1.3.0", update: { reviewed: { ...reviewed, folderHash: null } } }),
      (err: unknown) =>
        err instanceof InstallError && err.code === "changed-meanwhile" && /apps\/board changed since you reviewed/.test(err.message),
    );
    assert.equal(exists(".mixos/pending/apps/board"), false);
    const result = await installExtension("app", "board", { version: "1.3.0", update: { reviewed } });
    assert.equal(result.commitSha, to.commitSha);
    clearPending("board");
  });

  test("the release in place, unchanged, is nothing to update", async () => {
    const { installExtension, InstallError } = await install();
    await assert.rejects(
      installExtension("app", "board", { version: "1.2.0", update: {} }),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === "already-current" &&
        err.message === "apps/board already runs 1.2.0, and its files match it, so there is nothing to update.",
    );
  });

  test("only an app or a connector installed from this catalogue is updated", async () => {
    const { installExtension, InstallError } = await install();
    const refused = (pattern: RegExp) => (err: unknown) =>
      err instanceof InstallError && err.code === "not-updatable" && pattern.test(err.message);

    // A local extension, with no install record.
    fs.mkdirSync(path.join(root, "apps/local-app"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps/local-app/app.json"), '{"name":"Local"}\n');
    await assert.rejects(
      installExtension("app", "local-app", { update: {} }),
      refused(/^apps\/local-app has no install record \(apps\/local-app\/\.registry\.json\), so it is a local extension/),
    );
    // One installed from another catalogue.
    place("staged", release("board", "1.2.0"), "https://staging.mixos.example");
    await assert.rejects(
      installExtension("app", "staged", { update: {} }),
      refused(/^apps\/staged was installed from staging\.mixos\.example, and this instance installs from 127\.0\.0\.1:9/),
    );
    // Nothing in place.
    await assert.rejects(installExtension("app", "absent", { update: {} }), refused(/^Nothing named absent is in apps\//));
    // A theme, before any lock.
    await assert.rejects(installExtension("theme", "dusk", { update: {} }), refused(/^Updating a theme isn't supported yet/));
    assert.equal(exists(".mixos/lock"), false);
  });
});

// ── the update dialog's work ────────────────────────────────────────────────

describe("the update dialog", { concurrency: false }, () => {
  const revalidated: string[] = [];
  const ctx = {
    admin: async () => ADMIN,
    builtDeployment: () => false,
    revalidate: (p: string) => void revalidated.push(p),
  };

  test("the overview lists the releases newest first, with which way each goes, and starts on the current one", async () => {
    const { overviewForButton } = await import("./update-admin");
    const outcome = await overviewForButton({ kind: "app", slug: "board" }, ctx);
    assert.equal(outcome.ok, true);
    const o = outcome.ok ? outcome.overview : null;
    assert.equal(o?.name, "Board");
    assert.equal(o?.path, "apps/board");
    assert.equal(o?.host, "127.0.0.1:9");
    assert.deepEqual(o?.local, { state: "none" });
    assert.deepEqual(
      o?.releases.map((r) => [r.version, r.direction, r.current, r.yanked]),
      [
        ["1.4.0", "newer", false, true],
        ["1.3.0", "newer", true, false],
        ["1.2.0", "same", false, false],
      ],
    );
    assert.equal(o?.installed.releasedAt, "2026-10-01T12:00:00.000Z");
    assert.match(o?.installed.sourceUrl ?? "", /^https:\/\/github\.com\/mixoshq\/board\/tree\/[0-9a-f]{40}$/);
    assert.equal(o?.suggested, "1.3.0");
  });

  test("local edits are named against the installed release, which is downloaded and verified to do it", async () => {
    const { overviewForButton } = await import("./update-admin");
    const from = release("board", "1.2.0");
    fs.writeFileSync(BOARD_README, "# Board, edited here\n");
    fs.writeFileSync(path.join(root, "apps/board/api/items/extra.ts"), "export const extra = 1;\n");
    fs.writeFileSync(path.join(root, "apps/board/.gitignore"), "*.log\n");
    const manifest = path.join(root, "apps/board/app.json");
    const original = fs.readFileSync(manifest, "utf8");
    fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), lastUpdated: "2026-10-11T09:00:00.000Z" }));
    try {
      const before = downloads.length;
      const outcome = await overviewForButton({ kind: "app", slug: "board" }, ctx);
      assert.deepEqual(downloads.slice(before), [from.archivePath]);
      const local = outcome.ok ? outcome.overview.local : null;
      assert.equal(local?.state, "listed");
      if (local?.state === "listed") {
        assert.deepEqual([local.changed, local.added, local.removed], [["README.md"], ["api/items/extra.ts"], []]);
        assert.deepEqual(local.ignored, ["lastUpdated", "git-files"]);
      }

      // When GitHub no longer serves it, the folder differs and the files aren't named.
      withheld.add(from.archivePath);
      const unserved = await overviewForButton({ kind: "app", slug: "board" }, ctx);
      assert.deepEqual(unserved.ok && unserved.overview.local, {
        state: "unlisted",
        reason: `GitHub didn't serve 1.2.0 at commit ${from.commitSha.slice(0, 12)}, so the files that changed can't be named.`,
      });
    } finally {
      withheld.clear();
      fs.writeFileSync(BOARD_README, "# Board\n");
      fs.rmSync(path.join(root, "apps/board/api/items/extra.ts"));
      fs.rmSync(path.join(root, "apps/board/.gitignore"));
      fs.writeFileSync(manifest, original);
    }
  });

  test("the comparison shows the permissions, declarations and migrations that change, and a compare link", async () => {
    const { compareForButton } = await import("./update-admin");
    const from = release("board", "1.2.0");
    const to = release("board", "1.3.0");
    const outcome = await compareForButton({ kind: "app", slug: "board", version: "1.3.0" }, ctx);
    assert.equal(outcome.ok, true);
    const c = outcome.ok ? outcome.comparison : null;
    assert.equal(c?.direction, "newer");
    assert.deepEqual([c?.from.version, c?.from.releasedAt, c?.to.version, c?.to.releasedAt, c?.to.gitTag], [
      "1.2.0",
      "2026-10-01T12:00:00.000Z",
      "1.3.0",
      "2026-10-08T12:00:00.000Z",
      "v1.3.0",
    ]);
    assert.equal(c?.compareUrl, `https://github.com/mixoshq/board/compare/${from.commitSha}...${to.commitSha}`);
    assert.equal(c?.otherRepository, null);
    assert.deepEqual(c?.claims, {
      state: "ok",
      added: [{ scope: "network:files.example.com", reason: "Uploads attachments." }],
      removed: [],
      changed: [],
    });
    assert.deepEqual(c?.declarations, [
      { label: "Egress", added: ["files.example.com"], removed: [] },
      { label: "Env", added: ["BOARD_TOKEN (secret)"], removed: [] },
    ]);
    assert.deepEqual(c?.migrations, { added: ["0002_tags.sql"], changed: [], lacking: [] });
    assert.deepEqual([c?.floor.declared, c?.floor.met], ["0.0.1", true]);
    assert.deepEqual(c?.needs, { discardLocalChanges: false, allowOlder: false, allowYanked: false });
    assert.equal(c?.blocker, null);
    assert.deepEqual(c?.reviewed, {
      installedCommit: from.commitSha,
      installedFilesHash: filesHash(from.entries),
      folderHash: filesHash(from.entries),
      targetCommit: to.commitSha,
      targetContentHash: to.contentHash,
    });
  });

  test("a download that doesn't match its checksum is named as such, for the release and for the installed one", async () => {
    const { compareForButton, overviewForButton } = await import("./update-admin");
    const from = release("board", "1.2.0");
    const to = release("board", "1.3.0");
    const [served, installed] = [to.archive, from.archive];
    to.archive = from.archive;
    from.archive = served;
    fs.writeFileSync(BOARD_README, "# Board, edited here\n");
    try {
      const compared = await compareForButton({ kind: "app", slug: "board", version: "1.3.0" }, ctx);
      assert.deepEqual(compared.ok === false && [compared.code, compared.tone], ["checksum", "danger"]);
      const overview = await overviewForButton({ kind: "app", slug: "board" }, ctx);
      assert.deepEqual(overview.ok && overview.overview.local, {
        state: "unlisted",
        reason: "What GitHub serves for 1.2.0 no longer matches what was installed, so the files that changed can't be named.",
      });
    } finally {
      to.archive = served;
      from.archive = installed;
      fs.writeFileSync(BOARD_README, "# Board\n");
    }
  });

  test("a downgrade's comparison names the migrations the older release lacks, and links from older to newer", async () => {
    const { compareForButton } = await import("./update-admin");
    const [installed, older] = published.get("notes")!;
    const outcome = await compareForButton({ kind: "app", slug: "notes", version: older.version }, ctx);
    const c = outcome.ok ? outcome.comparison : null;
    assert.equal(c?.direction, "older");
    assert.deepEqual(c?.migrations, { added: [], changed: [], lacking: ["0002_pins.sql"] });
    assert.equal(c?.needs.allowOlder, true);
    assert.equal(c?.compareUrl, `https://github.com/mixoshq/notes/compare/${older.commitSha}...${installed.commitSha}`);
    // Website releases have no tag.
    assert.deepEqual([c?.from.gitTag, c?.to.gitTag], [null, null]);
  });

  test("a withdrawn release's comparison says so; the release in place is nothing to update", async () => {
    const { compareForButton } = await import("./update-admin");
    const withdrawn = await compareForButton({ kind: "app", slug: "board", version: "1.4.0" }, ctx);
    assert.deepEqual(withdrawn.ok && [withdrawn.comparison.to.yanked, withdrawn.comparison.to.yankedReason, withdrawn.comparison.needs.allowYanked], [
      true,
      "Corrupts boards.",
      true,
    ]);
    const same = await compareForButton({ kind: "app", slug: "board", version: "1.2.0" }, ctx);
    assert.equal(same.ok && same.comparison.blocker, "apps/board already runs 1.2.0, and its files match it, so there is nothing to update.");
    assert.equal(same.ok && same.comparison.compareUrl, null);
  });

  test("the update is audited with from, to, which way and whether local changes were discarded", async () => {
    const { compareForButton, updateFromButton } = await import("./update-admin");
    const [installed, older] = published.get("notes")!;
    const compared = await compareForButton({ kind: "app", slug: "notes", version: older.version }, ctx);
    assert.equal(compared.ok, true);
    if (!compared.ok) return;

    // Without "Install an older release": refused, and audited.
    const refused = await updateFromButton(
      { kind: "app", slug: "notes", version: older.version, reviewed: compared.comparison.reviewed },
      ctx,
    );
    assert.deepEqual(refused.ok === false && [refused.code, refused.tone], ["older-release", "warning"]);
    const [rejected] = rows("app.update.rejected");
    assert.deepEqual(
      [rejected.target_id, rejected.details.reason, rejected.details.version, rejected.details.via],
      ["notes", "older-release", older.version, "button"],
    );

    const outcome = await updateFromButton(
      { kind: "app", slug: "notes", version: older.version, allowOlder: true, reviewed: compared.comparison.reviewed },
      ctx,
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.ok && [outcome.result.pendingPath, outcome.result.direction, outcome.result.from.version], [
      ".mixos/pending/apps/notes",
      "older",
      installed.version,
    ]);
    assert.deepEqual(revalidated, ["/admin/apps"]);
    const [row] = rows("app.update");
    assert.equal(row.actor_email, ADMIN.email);
    assert.deepEqual(row.details.from, {
      version: installed.version,
      gitTag: null,
      commitSha: installed.commitSha,
      filesHash: compared.comparison.reviewed.installedFilesHash,
    });
    assert.deepEqual(
      [
        (row.details.to as { version: string }).version,
        (row.details.to as { commitSha: string }).commitSha,
        row.details.direction,
        row.details.localChangesDiscarded,
        row.details.pendingPath,
        row.details.via,
      ],
      [older.version, older.commitSha, "older", false, ".mixos/pending/apps/notes", "button"],
    );
    clearPending("notes");
  });

  test("a built deployment is told how updating works, and the refusal is audited", async () => {
    const { overviewForButton, updateFromButton } = await import("./update-admin");
    const { BUILT_DEPLOYMENT_UPDATE_NOTICE } = await import("../platform/build");
    const built = { ...ctx, builtDeployment: () => true };
    assert.deepEqual(await overviewForButton({ kind: "app", slug: "board" }, built), {
      ok: false,
      code: "unsupported-environment",
      message: BUILT_DEPLOYMENT_UPDATE_NOTICE,
      tone: "info",
    });
    const before = rows("app.update.rejected").length;
    const to = release("board", "1.3.0");
    const outcome = await updateFromButton(
      {
        kind: "app",
        slug: "board",
        version: "1.3.0",
        reviewed: {
          installedCommit: to.commitSha,
          installedFilesHash: to.contentHash,
          folderHash: null,
          targetCommit: to.commitSha,
          targetContentHash: to.contentHash,
        },
      },
      built,
    );
    assert.equal(outcome.ok === false && outcome.code, "unsupported-environment");
    assert.equal(rows("app.update.rejected").length, before + 1);
    assert.equal(exists(".mixos/pending/apps/board"), false);
  });

  test("each action requires an admin first, and refuses what isn't a release of an extension", async () => {
    const { compareForButton, overviewForButton, updateFromButton } = await import("./update-admin");
    const notAdmin = { ...ctx, admin: async () => Promise.reject(new Error("Forbidden")) };
    await assert.rejects(overviewForButton({ kind: "app", slug: "board" }, notAdmin), /Forbidden/);
    await assert.rejects(compareForButton({ kind: "app", slug: "board", version: "1.3.0" }, notAdmin), /Forbidden/);
    await assert.rejects(updateFromButton({ kind: "app", slug: "board", version: "1.3.0" }, notAdmin), /Forbidden/);
    for (const input of [
      { kind: "app", slug: "../board" },
      { kind: "plugin", slug: "board" },
    ]) {
      assert.equal((await overviewForButton(input, ctx)).ok, false);
    }
    const bad = await compareForButton({ kind: "app", slug: "board", version: "1.3.0 && rm" }, ctx);
    assert.equal(bad.ok === false && bad.code, "not-updatable");
  });
});
