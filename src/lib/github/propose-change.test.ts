/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pure parts of proposing an update or a removal: how the record on the
 * default branch is compared with the build's, what two releases in memory
 * differ by, and removal's refusals from a build's facts, with no checkout,
 * network or database. The whole flow runs against the fake GitHub in
 * ./propose.integration.test.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { InstallRecord, RegistryInstall } from "@/lib/repository/install-record";
import { dependentsOf, type DependencyFacts } from "@/lib/repository/remove";
import type { TarEntry } from "@/lib/repository/tar";
import { releaseDifferences } from "@/lib/repository/update";
import { recordDifferences } from "./propose";

const record: InstallRecord = {
  source: "https://mixos.org",
  kind: "app",
  slug: "files",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  contentHash: `sha256-${"A".repeat(43)}=`,
  filesHash: `sha256-${"B".repeat(43)}=`,
  repository: { owner: "acme", name: "mixos-files", subpath: "apps/files" },
  requiresMixOS: "0.1.0",
};

const build: RegistryInstall = {
  kind: "app",
  slug: "files",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: record.commitSha,
  source: "https://mixos.org",
  repository: { owner: "acme", name: "mixos-files", subpath: "apps/files" },
  requiresMixOS: "0.1.0",
  modified: false,
};

const files = (spec: Record<string, string>): TarEntry[] =>
  Object.entries(spec).map(([path, text]) => ({ path, mode: 0o644, data: Buffer.from(text) }));

describe("the record on the default branch against the build's", () => {
  test("the same release is no difference; each field that differs is named", () => {
    assert.deepEqual(recordDifferences(record, build), []);
    assert.deepEqual(recordDifferences(record, { ...build, repository: { owner: "Acme", name: "MixOS-Files", subpath: "apps/files" } }), []);
    assert.deepEqual(recordDifferences({ ...record, version: "1.3.0" }, build), ["version 1.3.0, and this build runs 1.2.0"]);
    assert.deepEqual(recordDifferences({ ...record, commitSha: "f".repeat(40) }, build), [
      `commit ${"f".repeat(12)}, and this build runs 0123456789ab`,
    ]);
    assert.deepEqual(recordDifferences({ ...record, source: "http://localhost:4321" }, build), [
      "localhost:4321 as its catalogue, and this build's record names mixos.org",
    ]);
    assert.deepEqual(recordDifferences({ ...record, repository: { owner: "someone", name: "mixos-files", subpath: "apps/files" } }, build), [
      "someone/mixos-files/apps/files as its source, and this build's record names acme/mixos-files/apps/files",
    ]);
    assert.deepEqual(recordDifferences({ ...record, repository: { ...record.repository, subpath: null } }, build), [
      "acme/mixos-files as its source, and this build's record names acme/mixos-files/apps/files",
    ]);
    assert.equal(recordDifferences({ ...record, version: "1.3.0", commitSha: "f".repeat(40) }, build).length, 2);
  });
});

describe("what two releases in memory differ by", () => {
  test("changed, added and deleted, by path, sorted", () => {
    const before = files({ "app.json": "{}", "README.md": "# a", "api/[id]/route.ts": "x", "assets/icon.png": "\u0089PNG" });
    const after = files({ "app.json": '{"name":"b"}', "api/items/route.ts": "y", "assets/icon.png": "\u0089PNG", "migrations/002.sql": "select 1" });
    assert.deepEqual(releaseDifferences(before, after), {
      changed: ["app.json"],
      added: ["api/items/route.ts", "migrations/002.sql"],
      removed: ["README.md", "api/[id]/route.ts"],
      more: { changed: 0, added: 0, removed: 0 },
      incomplete: false,
    });
    assert.deepEqual(releaseDifferences(before, before).changed, []);
    const many = files(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, "x"])));
    const diff = releaseDifferences([], many);
    assert.equal(diff.added.length, 50);
    assert.equal(diff.more.added, 10);
  });
});

describe("removal's refusals from a build's facts", () => {
  const facts = (over: Partial<DependencyFacts> = {}): DependencyFacts => ({
    here: "instance",
    apps: [
      { slug: "mailer", name: "Mailer", connectors: ["probe"], optionalConnectors: ["other"], consumes: [], listensTo: [] },
      { slug: "notes", name: "Notes", connectors: [], optionalConnectors: [], consumes: ["acme"], listensTo: [] },
      { slug: "board", name: "Board", connectors: [], optionalConnectors: [], consumes: [], listensTo: ["acme"] },
      { slug: "acme", name: "Acme", connectors: [], optionalConnectors: [], consumes: ["acme"], listensTo: [] },
    ],
    themes: [{ slug: "aurora", name: "Aurora" }],
    storedTheme: async () => "aurora",
    ...over,
  });

  test("a required connector, a consumed or listened-to app, and the last theme refuse; the rest warns", async () => {
    const probe = await dependentsOf(facts(), "connector", "probe");
    assert.deepEqual(probe.blockers.map((b) => [b.code, b.apps.map((a) => a.slug)]), [["required-by", ["mailer"]]]);
    assert.match(probe.blockers[0].message, /^Required by Mailer \(apps\/mailer\), which can't work without it\./);
    const other = await dependentsOf(facts(), "connector", "other");
    assert.deepEqual(other.blockers, []);
    assert.deepEqual(other.warnings.map((w) => w.code), ["optional-for"]);
    const acme = await dependentsOf(facts(), "app", "acme");
    assert.deepEqual(acme.blockers.map((b) => [b.code, b.apps.map((a) => a.slug)]), [
      ["consumed-by", ["notes"]],
      ["listened-to-by", ["board"]],
    ]);
    assert.deepEqual((await dependentsOf(facts(), "app", "notes")).blockers, []);

    let asked = 0;
    const last = await dependentsOf(facts({ storedTheme: async () => (asked++, "aurora") }), "theme", "aurora");
    assert.deepEqual(last.blockers.map((b) => b.code), ["last-theme"]);
    assert.match(last.blockers[0].message, /only theme in the build, and the build needs one/);
    assert.equal(asked, 0, "the database isn't asked for the last theme");
  });

  test("the applied theme warns in this instance's words, naming the one pages use next", async () => {
    const two = facts({ themes: [{ slug: "aurora", name: "Aurora" }, { slug: "dusk", name: "Dusk" }] });
    const applied = await dependentsOf(two, "theme", "aurora");
    assert.deepEqual(applied.blockers, []);
    assert.match(applied.warnings[0]?.message ?? "", /^It is the applied theme in this instance's database, so pages here use Dusk once it's gone/);
    const none = await dependentsOf({ ...two, storedTheme: async () => null }, "theme", "aurora");
    assert.match(none.warnings[0]?.message ?? "", /^No theme is applied in this instance's database, so pages here use the first theme by name, which is this one\. They use Dusk/);
    assert.deepEqual((await dependentsOf({ ...two, storedTheme: async () => undefined }, "theme", "dusk")).warnings, []);
  });
});
