/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The install record, `.registry.json`: what each field may hold, how it is
 * written and read, the folder hash that leaves it out, and where a download
 * URL says an extension came from.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesHash } from "./content-hash";
import {
  INSTALL_RECORD_FILE,
  InstallRecordSchema,
  folderFiles,
  githubSourceUrl,
  installRecordEntry,
  parseInstallRecord,
  readInstallRecord,
  recordListingUrl,
  recordMismatch,
  recordSourceUrl,
  repositoryFromTarballUrl,
  serializeInstallRecord,
  type InstallRecord,
} from "./install-record";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-install-record-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const SHA = "9f2b".padEnd(40, "0");
const HASH = filesHash([{ path: "app.json", mode: 0o644, data: Buffer.from("{}\n") }]);

const RECORD: InstallRecord = {
  source: "https://mixos.org",
  kind: "app",
  slug: "files",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: SHA,
  contentHash: HASH,
  filesHash: HASH,
  repository: { owner: "acme", name: "mixos-files", subpath: null },
  requiresMixOS: "0.4.0",
};

const accepts = (fields: Partial<InstallRecord>) => InstallRecordSchema.safeParse({ ...RECORD, ...fields }).success;

describe("what a record may hold", () => {
  test("a release from mixos.org, tagged or published from the website", () => {
    assert.ok(accepts({}));
    assert.ok(accepts({ version: "9f2b1c4", gitTag: null }));
    assert.ok(accepts({ version: "2.0.0-rc.1+build.5", requiresMixOS: null }));
    assert.ok(accepts({ source: "http://127.0.0.1:4321", repository: { owner: "a-b", name: "x.y_z", subpath: "apps/files" } }));
  });

  test("a version that is neither dotted nor a commit's hex is refused", () => {
    for (const version of ["1.2", "v1.2.0", "latest", "1.2.0 [skip ci]", "1.2.0\nskip-checks: true", "9F2B1C4", "9f2b1c", ""]) {
      assert.equal(accepts({ version }), false, version);
    }
  });

  test("a source that isn't an origin is refused", () => {
    for (const source of ["https://mixos.org/", "https://mixos.org/api/v1", "mixos.org", "ftp://mixos.org", "https://user@mixos.org"]) {
      assert.equal(accepts({ source }), false, source);
    }
  });

  test("a tag, a repository or a subpath GitHub and mixos.org wouldn't accept is refused", () => {
    for (const gitTag of ["../v1", "v1 2", "v1.lock", ".v1", "a//b", "v1."]) assert.equal(accepts({ gitTag }), false, gitTag);
    for (const repository of [
      { owner: "acme/../x", name: "board", subpath: null },
      { owner: "-acme", name: "board", subpath: null },
      { owner: "acme", name: "..", subpath: null },
      { owner: "acme", name: "board", subpath: "../etc" },
      { owner: "acme", name: "board", subpath: "/apps/x" },
      { owner: "acme", name: "board", subpath: "apps/a b" },
    ]) {
      assert.equal(accepts({ repository }), false, JSON.stringify(repository));
    }
  });

  test("anything else wrong, or an extra field, is refused", () => {
    assert.equal(accepts({ commitSha: "main" }), false);
    assert.equal(accepts({ filesHash: "sha256-nope" }), false);
    assert.equal(accepts({ slug: "Files" }), false);
    assert.equal(accepts({ requiresMixOS: "0.4\n" }), false);
    assert.equal(InstallRecordSchema.safeParse({ ...RECORD, installedAt: "2026-10-11" }).success, false);
  });
});

describe("writing and reading it", () => {
  test("is written in one key order, and read back as it was", () => {
    const text = serializeInstallRecord({ ...RECORD, requiresMixOS: null, gitTag: null });
    assert.deepEqual(Object.keys(JSON.parse(text)), [
      "$schema",
      "source",
      "kind",
      "slug",
      "version",
      "gitTag",
      "commitSha",
      "contentHash",
      "filesHash",
      "repository",
      "requiresMixOS",
    ]);
    assert.ok(text.endsWith("}\n"));
    assert.deepEqual(parseInstallRecord(text), { ok: true, record: { ...RECORD, requiresMixOS: null, gitTag: null } });
    assert.equal(installRecordEntry(RECORD).path, INSTALL_RECORD_FILE);
    assert.equal(installRecordEntry(RECORD).mode, 0o644);
  });

  test("an invalid record is never written", () => {
    assert.throws(() => serializeInstallRecord({ ...RECORD, version: "1.2.0 [skip ci]" }));
  });

  test("a missing record, a link, a folder, a large file and bad JSON each read as what they are", () => {
    const dir = (name: string) => {
      const d = path.join(tmp, `${name}-${n++}`);
      fs.mkdirSync(d);
      return d;
    };
    assert.deepEqual(readInstallRecord(dir("none")), { state: "missing" });

    const good = dir("good");
    fs.writeFileSync(path.join(good, INSTALL_RECORD_FILE), serializeInstallRecord(RECORD));
    assert.deepEqual(readInstallRecord(good), { state: "ok", record: RECORD });

    const linked = dir("linked");
    fs.symlinkSync(path.join(good, INSTALL_RECORD_FILE), path.join(linked, INSTALL_RECORD_FILE));
    assert.deepEqual(readInstallRecord(linked), { state: "invalid", reason: "it is a link" });

    const folder = dir("folder");
    fs.mkdirSync(path.join(folder, INSTALL_RECORD_FILE));
    assert.equal(readInstallRecord(folder).state, "invalid");

    const large = dir("large");
    fs.writeFileSync(path.join(large, INSTALL_RECORD_FILE), " ".repeat(65 * 1024));
    assert.match((readInstallRecord(large) as { reason: string }).reason, /too large/);

    const text = dir("text");
    fs.writeFileSync(path.join(text, INSTALL_RECORD_FILE), "not json");
    assert.deepEqual(readInstallRecord(text), { state: "invalid", reason: "it is not JSON" });

    const wrong = dir("wrong");
    fs.writeFileSync(
      path.join(wrong, INSTALL_RECORD_FILE),
      JSON.stringify({ $schema: "https://mixos.org/schemas/registry-install/v1.json", ...RECORD, version: "latest" }),
    );
    assert.match((readInstallRecord(wrong) as { reason: string }).reason, /^version: /);

    // Which shape it is comes first: a record with none, or another, says so.
    const shapeless = dir("shapeless");
    fs.writeFileSync(path.join(shapeless, INSTALL_RECORD_FILE), JSON.stringify(RECORD));
    assert.match((readInstallRecord(shapeless) as { reason: string }).reason, /has no "\$schema"/);
    const newer = dir("newer");
    fs.writeFileSync(
      path.join(newer, INSTALL_RECORD_FILE),
      JSON.stringify({ $schema: "https://mixos.org/schemas/registry-install/v2.json", ...RECORD }),
    );
    assert.match((readInstallRecord(newer) as { reason: string }).reason, /It needs a newer MixOS/);
  });

  test("a record is its folder's only when it names that kind and slug", () => {
    assert.equal(recordMismatch(RECORD, "app", "files"), null);
    assert.equal(recordMismatch(RECORD, "connector", "files"), "it records app/files, not connector/files");
    assert.equal(recordMismatch(RECORD, "app", "other"), "it records app/files, not app/other");
  });
});

describe("the folder", () => {
  test("folderFiles lists every file with its size, the record included, links left out", () => {
    const dir = path.join(tmp, `files-${n++}`);
    fs.mkdirSync(path.join(dir, "api", "items"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app.json"), "{}\n");
    fs.writeFileSync(path.join(dir, "api", "items", "route.ts"), "export {};\n");
    fs.writeFileSync(path.join(dir, INSTALL_RECORD_FILE), serializeInstallRecord(RECORD));
    fs.symlinkSync("/etc/hosts", path.join(dir, "hosts"));
    assert.deepEqual(folderFiles(dir), [
      { path: INSTALL_RECORD_FILE, bytes: serializeInstallRecord(RECORD).length },
      { path: "api/items/route.ts", bytes: 11 },
      { path: "app.json", bytes: 3 },
    ]);
  });
});

describe("where it came from", () => {
  test("the repository is read from each form of download URL install accepts", () => {
    for (const url of [
      `https://codeload.github.com/acme/mixos-files/tar.gz/${SHA}`,
      `https://codeload.github.com/acme/mixos-files/legacy.tar.gz/${SHA}`,
      `https://api.github.com/repos/acme/mixos-files/tarball/${SHA}`,
      `https://github.com/acme/mixos-files/archive/${SHA}.tar.gz`,
    ]) {
      assert.deepEqual(repositoryFromTarballUrl(url), { owner: "acme", name: "mixos-files" }, url);
    }
  });

  test("anything else names no repository", () => {
    for (const url of [
      `http://codeload.github.com/acme/mixos-files/tar.gz/${SHA}`,
      `https://example.com/acme/mixos-files/tar.gz/${SHA}`,
      `https://codeload.github.com/acme/tar.gz/${SHA}`,
      `https://api.github.com/acme/mixos-files/tarball/${SHA}`,
      `https://github.com/acme%2F..%2Fx/board/archive/${SHA}.tar.gz`,
      "not a url",
    ]) {
      assert.equal(repositoryFromTarballUrl(url), null, url);
    }
  });

  test("the source link is GitHub's tree at the installed commit", () => {
    const sha = "a".repeat(40);
    assert.equal(
      githubSourceUrl({ owner: "acme", name: "mixos-apps" }, sha, "apps/acme board"),
      `https://github.com/acme/mixos-apps/tree/${sha}/apps/acme%20board`,
    );
    assert.equal(githubSourceUrl({ owner: "acme", name: "board" }, sha, null), `https://github.com/acme/board/tree/${sha}`);
    // Nothing GitHub wouldn't serve, and nothing that climbs out of the tree.
    assert.equal(githubSourceUrl({ owner: "acme/../x", name: "board" }, sha), null);
    assert.equal(githubSourceUrl({ owner: "acme", name: ".." }, sha), null);
    assert.equal(githubSourceUrl({ owner: "acme", name: "board" }, sha, "apps/../../etc"), null);
    assert.equal(githubSourceUrl({ owner: "acme", name: "board" }, "main"), null);
    assert.equal(
      recordSourceUrl({ ...RECORD, repository: { owner: "acme", name: "mixos", subpath: "apps/files" } }),
      `https://github.com/acme/mixos/tree/${SHA}/apps/files`,
    );
  });

  test("the listing is on the catalogue the record names", () => {
    assert.equal(recordListingUrl(RECORD), "https://mixos.org/extend/apps/files");
    assert.equal(
      recordListingUrl({ source: "http://localhost:4321", kind: "connector", slug: "crm" }),
      "http://localhost:4321/extend/connectors/crm",
    );
  });
});
