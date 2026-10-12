/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pending installs on disk: the files hash an install records and Register
 * recomputes from the folder, the sidecar, and what is listed as pending.
 * The install record itself is ./install-record.test.ts's.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesHash, hashFileTree } from "./content-hash";
import {
  FolderReadError,
  INSTALL_RECORD_FILE,
  folderFilesHash,
  serializeInstallRecord,
  type InstallRecord,
} from "./install-record";
import {
  PendingError,
  listPendingInstalls,
  pendingLocation,
  readSidecar,
  stagingLocation,
  writeSidecar,
  type PendingKind,
  type PendingSidecar,
} from "./pending";
import type { TarEntry } from "./tar";

// ── fixtures ────────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-pending-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const file = (p: string, data: string, mode = 0o644): TarEntry => ({ path: p, mode, data: Buffer.from(data) });

const TREE = [
  file("app.json", '{"name":"Acme"}\n'),
  file("api/items/route.ts", "export {};\n"),
  file("lib/helper.ts", "export const x = 1;\n"),
  file(".eslintrc.json", "{}\n"),
  file("node_modules/pkg/index.js", "module.exports = 1;\n"),
];

/** The tree written to a folder of its own, as install writes it: every file 0644. */
function written(entries: TarEntry[]): string {
  const dir = path.join(tmp, `tree-${n++}`);
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, e.path), e.data, { mode: 0o644 });
  }
  return dir;
}

function sidecar(fields: Partial<PendingSidecar> = {}): PendingSidecar {
  return {
    kind: "app",
    slug: "acme",
    yankedAccepted: false,
    installedAt: new Date().toISOString(),
    installedBy: "admin@example.com",
    check: { verdict: "accepted", deferred: [] },
    ...fields,
  };
}

/** The install record install writes for TREE as `kind`/`slug`. */
function record(kind: PendingKind, slug: string): InstallRecord {
  return {
    source: "https://mixos.org",
    kind,
    slug,
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "a".repeat(40),
    contentHash: hashFileTree(TREE),
    filesHash: filesHash(TREE),
    repository: { owner: "acme", name: "mixos-apps", subpath: null },
    requiresMixOS: null,
  };
}

/** What a sidecar from before the record moved into the folder held. */
function earlierSidecar() {
  return {
    ...sidecar(),
    source: "https://mixos.org",
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "a".repeat(40),
    contentHash: hashFileTree(TREE),
    filesHash: filesHash(TREE),
    requiresMixOS: null,
    fileCount: TREE.length,
    byteCount: 42,
  };
}

// ── filesHash ───────────────────────────────────────────────────────────────

describe("filesHash", () => {
  test("is the same for a tree with and without execute bits, which the content hash tells apart", () => {
    const executable = TREE.map((e) => (e.path === "lib/helper.ts" ? { ...e, mode: 0o755 } : e));
    assert.equal(filesHash(executable), filesHash(TREE));
    assert.notEqual(hashFileTree(executable), hashFileTree(TREE));
  });

  test("equals the content hash for a tree with no executable file", () => {
    assert.equal(filesHash(TREE), hashFileTree(TREE));
  });

  test("changes with any file's bytes or path", () => {
    const base = filesHash(TREE);
    assert.notEqual(filesHash(TREE.map((e) => (e.path === "app.json" ? file("app.json", "{}\n") : e))), base);
    assert.notEqual(filesHash(TREE.map((e) => (e.path === "app.json" ? { ...e, path: "manifest.json" } : e))), base);
    assert.notEqual(filesHash([...TREE, file("extra.ts", "")]), base);
  });
});

describe("folderFilesHash", () => {
  test("leaves out the install record at the folder's root, and only there", () => {
    const dir = written(TREE);
    fs.writeFileSync(path.join(dir, INSTALL_RECORD_FILE), serializeInstallRecord(record("app", "acme")));
    assert.equal(folderFilesHash(dir), filesHash(TREE));
    // Anywhere else it is a file like any other, which pre-flight refuses to install.
    fs.writeFileSync(path.join(dir, "lib", INSTALL_RECORD_FILE), "{}\n");
    assert.notEqual(folderFilesHash(dir), filesHash(TREE));
  });

  test("from the folder install wrote, it is what install recorded", () => {
    const executable = TREE.map((e) => (e.path === "lib/helper.ts" ? { ...e, mode: 0o755 } : e));
    assert.equal(folderFilesHash(written(executable)), filesHash(executable));
  });

  test("counts dot files and node_modules/, which install wrote and which could run", () => {
    const dir = written(TREE);
    const base = folderFilesHash(dir);
    fs.writeFileSync(path.join(dir, "node_modules/pkg/index.js"), "module.exports = 2;\n");
    assert.notEqual(folderFilesHash(dir), base);
  });

  test("changes when a file is edited, added or removed after install", () => {
    const base = filesHash(TREE);
    const edited = written(TREE);
    fs.appendFileSync(path.join(edited, "api/items/route.ts"), "// later\n");
    const added = written(TREE);
    fs.writeFileSync(path.join(added, "api/items/extra.ts"), "export {};\n");
    const removed = written(TREE);
    fs.rmSync(path.join(removed, "lib/helper.ts"));
    for (const dir of [edited, added, removed]) assert.notEqual(folderFilesHash(dir), base);
  });

  test("an empty folder counts for nothing, as in the content hash", () => {
    const dir = written(TREE);
    fs.mkdirSync(path.join(dir, "empty"));
    assert.equal(folderFilesHash(dir), filesHash(TREE));
  });

  test("refuses a link, which install never writes, rather than read through it", () => {
    const dir = written(TREE);
    const outside = path.join(tmp, `outside-${n++}.ts`);
    fs.writeFileSync(outside, "export {};\n");
    fs.symlinkSync(outside, path.join(dir, "lib/linked.ts"));
    assert.throws(() => folderFilesHash(dir), (err: unknown) => err instanceof FolderReadError && /lib\/linked\.ts is a symbolic link/.test(err.message));
  });
});

// ── the sidecar ─────────────────────────────────────────────────────────────

describe("the sidecar", () => {
  test("is written whole and read back", () => {
    const file = path.join(tmp, `sidecar-${n++}.json`);
    const value = sidecar();
    writeSidecar(file, value);
    assert.deepEqual(readSidecar(file), { state: "ok", sidecar: value });
    // Nothing half-written is left beside it.
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")), []);
  });

  test("keeps what install left out, by name, and reads a count it couldn't have written as unreadable", () => {
    const file = path.join(tmp, `sidecar-${n++}.json`);
    const value = sidecar({ leftOut: { ".gitignore": 2, ".gitattributes": 1 } });
    writeSidecar(file, value);
    assert.deepEqual(readSidecar(file), { state: "ok", sidecar: value });
    for (const leftOut of [{ ".git": 1 }, { ".gitignore": 0 }, { ".gitignore": "2" }, [".gitignore"]]) {
      fs.writeFileSync(file, JSON.stringify({ ...sidecar(), leftOut }));
      assert.equal(readSidecar(file).state, "unreadable", JSON.stringify(leftOut));
    }
  });

  test("an update records what it replaces, and a record of it that isn't one reads as unreadable", () => {
    const file = path.join(tmp, `sidecar-${n++}.json`);
    const replaces = {
      version: "1.2.0",
      gitTag: "v1.2.0",
      commitSha: "a".repeat(40),
      filesHash: filesHash(TREE),
      folderHash: null,
      localChangesDiscarded: true,
      direction: "older" as const,
    };
    writeSidecar(file, sidecar({ replaces }));
    const read = readSidecar(file);
    assert.deepEqual(read.state === "ok" && read.sidecar.replaces, replaces);
    for (const bad of [
      { ...replaces, version: "1.2 beta" },
      { ...replaces, direction: "sideways" },
      { ...replaces, folderHash: "not a hash" },
      { ...replaces, extra: true },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...sidecar(), replaces: bad }));
      assert.equal(readSidecar(file).state, "unreadable", JSON.stringify(bad));
    }
  });

  test("a registration under way is recorded in it", () => {
    const file = path.join(tmp, `sidecar-${n++}.json`);
    const register = { token: "0123456789abcdef-token", pid: 123, hostname: "host", startedAt: new Date().toISOString() };
    writeSidecar(file, sidecar({ register }));
    const read = readSidecar(file);
    assert.equal(read.state, "ok");
    assert.deepEqual(read.state === "ok" && read.sidecar.register, register);
  });

  test("missing, not JSON, a field missing or one too many, and a link each read as what they are", () => {
    const dir = path.join(tmp, `sidecars-${n++}`);
    fs.mkdirSync(dir);
    assert.deepEqual(readSidecar(path.join(dir, "none.json")), { state: "missing" });
    const cases: Record<string, string> = {
      "text.json": "not json",
      "short.json": JSON.stringify({ ...sidecar(), installedBy: undefined }),
      "extra.json": JSON.stringify({ ...sidecar(), extra: 1 }),
      "baddate.json": JSON.stringify({ ...sidecar(), installedAt: "yesterday" }),
    };
    for (const [name, text] of Object.entries(cases)) {
      fs.writeFileSync(path.join(dir, name), text);
      assert.equal(readSidecar(path.join(dir, name)).state, "unreadable", name);
    }
    fs.writeFileSync(path.join(dir, "real.json"), JSON.stringify(sidecar()));
    fs.symlinkSync(path.join(dir, "real.json"), path.join(dir, "link.json"));
    assert.equal(readSidecar(path.join(dir, "link.json")).state, "unreadable");
  });
});

describe("a sidecar an earlier version wrote", () => {
  test("is told apart, since it held what install verified, which is now in the folder's record", () => {
    const file = path.join(tmp, `sidecar-${n++}.json`);
    fs.writeFileSync(file, JSON.stringify(earlierSidecar(), null, 2));
    const read = readSidecar(file);
    assert.equal(read.state, "unreadable");
    assert.equal(read.state === "unreadable" && read.earlier, true);
    assert.match(read.state === "unreadable" ? read.reason : "", /earlier version of MixOS/);
  });
});

// ── where things are, and what is pending ───────────────────────────────────

describe("locations", () => {
  test("are under .mixos/, by kind and slug", () => {
    const root = path.join(tmp, "root");
    assert.deepEqual(pendingLocation(root, "app", "acme"), {
      folder: path.join(root, ".mixos", "pending", "apps", "acme"),
      sidecar: path.join(root, ".mixos", "pending", "apps", "acme.json"),
      rel: ".mixos/pending/apps/acme",
    });
    assert.equal(stagingLocation(root, "theme", "aurora").rel, ".mixos/staging/themes/aurora");
  });

  test("refuse anything that is not a slug", () => {
    for (const slug of ["..", "a/b", "Acme", "a", "../x", "acme.json"]) {
      assert.throws(() => pendingLocation(tmp, "app", slug), PendingError, slug);
    }
  });
});

describe("listPendingInstalls", () => {
  test("lists each pending install with what stands in its way", () => {
    const root = path.join(tmp, `checkout-${n++}`);
    /** A pending folder as install leaves one, its record named `kind`/`slug` unless said otherwise. */
    const pendWith = (kind: PendingKind, slug: string, recordAs: [PendingKind, string] | null = [kind, slug]) => {
      const where = pendingLocation(root, kind, slug);
      fs.mkdirSync(where.folder, { recursive: true });
      if (recordAs) {
        fs.writeFileSync(path.join(where.folder, INSTALL_RECORD_FILE), serializeInstallRecord(record(...recordAs)));
      }
      return where;
    };

    const ok = pendWith("app", "good");
    writeSidecar(ok.sidecar, sidecar({ slug: "good" }));

    pendWith("app", "bare");

    const noFolder = pendingLocation(root, "connector", "gone");
    fs.mkdirSync(path.dirname(noFolder.sidecar), { recursive: true });
    writeSidecar(noFolder.sidecar, sidecar({ kind: "connector", slug: "gone" }));

    const stopped = pendWith("connector", "midway");
    writeSidecar(
      stopped.sidecar,
      sidecar({ kind: "connector", slug: "midway", register: { token: "0123456789abcdef-x", pid: 1, hostname: "h", startedAt: new Date().toISOString() } }),
    );

    const unrecorded = pendWith("app", "unrecorded", null);
    writeSidecar(unrecorded.sidecar, sidecar({ slug: "unrecorded" }));

    const borrowed = pendWith("app", "borrowed", ["app", "other"]);
    writeSidecar(borrowed.sidecar, sidecar({ slug: "borrowed" }));

    const earlier = pendWith("app", "earlier", null);
    fs.writeFileSync(earlier.sidecar, JSON.stringify(earlierSidecar()));

    const listing = listPendingInstalls(root);
    const listed = listing.map((p) => ({ id: `${p.kind}/${p.slug}`, problem: p.problem && p.problem.split(" ").slice(0, 4).join(" ") }));
    assert.deepEqual(listed, [
      { id: "app/bare", problem: "It has no record" },
      { id: "app/borrowed", problem: "Its install record (.mixos/pending/apps/borrowed/.registry.json)" },
      { id: "app/earlier", problem: "An earlier version of" },
      { id: "app/good", problem: null },
      { id: "app/unrecorded", problem: "It has no install" },
      { id: "connector/gone", problem: ".mixos/pending/connectors/gone/ is missing, so" },
      { id: "connector/midway", problem: "A registration of it" },
    ]);
    const byId = new Map(listing.map((p) => [`${p.kind}/${p.slug}`, p]));
    assert.equal(byId.get("app/good")?.record?.version, "1.2.0");
    assert.equal(byId.get("app/borrowed")?.record, null);
    assert.match(byId.get("app/borrowed")?.problem ?? "", /it records app\/other, not app\/borrowed\. Discard it and install it again\./);
    assert.match(byId.get("app/earlier")?.problem ?? "", /Discard it and install it again\./);
  });

  test("is empty for a checkout with nothing pending", () => {
    assert.deepEqual(listPendingInstalls(path.join(tmp, "nothing-here")), []);
  });
});
