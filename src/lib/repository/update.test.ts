/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An update's rules and comparisons (./update.ts): which way it goes, what
 * changed in a folder since its release was installed, and what the release
 * it goes to changes. Folders are written to a temporary directory; nothing
 * is downloaded.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesHash } from "./content-hash";
import type { TarEntry } from "./tar";
import {
  compareClaims,
  compareDeclarations,
  compareDottedVersions,
  compareMigrations,
  folderDifferences,
  folderMigrations,
  folderState,
  localChangesBetween,
  needsOlderConsent,
  onlyLastUpdated,
  releaseMigrations,
  sameRepository,
  shownClaims,
  unhashableProblem,
  updateDirection,
  type ReleaseRef,
} from "./update";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-update-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const file = (p: string, data: string, mode = 0o644): TarEntry => ({ path: p, mode, data: Buffer.from(data) });

/** A folder holding `entries`, as install writes them, with a record at its root. */
function folder(entries: TarEntry[]): string {
  const dir = path.join(tmp, `folder-${n++}`);
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, e.path), e.data, { mode: 0o644 });
  }
  fs.writeFileSync(path.join(dir, ".registry.json"), "{}\n");
  return dir;
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const ref = (version: string, commitSha: string, releasedAt: string | null = null): ReleaseRef => ({
  version,
  commitSha,
  releasedAt,
});

describe("which way an update goes", () => {
  test("two dotted versions decide it, in semver's order", () => {
    assert.equal(updateDirection(ref("1.2.0", A), ref("1.3.0", B)), "newer");
    assert.equal(updateDirection(ref("1.10.0", A), ref("1.9.3", B)), "older");
    // A prerelease comes before the release it leads to; build metadata doesn't count.
    assert.equal(updateDirection(ref("1.3.0-rc.1", A), ref("1.3.0", B)), "newer");
    assert.equal(updateDirection(ref("1.3.0", A), ref("1.3.0-rc.2", B)), "older");
    assert.equal(updateDirection(ref("1.3.0-rc.2", A), ref("1.3.0-rc.10", B)), "newer");
    assert.equal(compareDottedVersions("1.2.0+build.5", "1.2.0+build.9"), 0);
    // The versions decide it even when the dates say otherwise: a 1.x fix published after 2.0.0.
    assert.equal(updateDirection(ref("2.0.0", A, "2026-10-01T00:00:00Z"), ref("1.4.1", B, "2026-10-09T00:00:00Z")), "older");
  });

  test("website releases, named by their commits, go by the dates the catalogue published them", () => {
    assert.equal(updateDirection(ref("b2c3d4e", A, "2026-10-09T12:00:00Z"), ref("a1b2c3d", B, "2026-10-01T12:00:00Z")), "older");
    assert.equal(updateDirection(ref("a1b2c3d", A, "2026-10-01T12:00:00Z"), ref("b2c3d4e", B, "2026-10-09T12:00:00Z")), "newer");
    // An all-digit commit isn't a dotted version either.
    assert.equal(updateDirection(ref("1234567", A, "2026-10-09T12:00:00Z"), ref("1.0.0", B, "2026-10-10T12:00:00Z")), "newer");
    // A dotted version and a commit: the dates.
    assert.equal(updateDirection(ref("1.2.0", A, "2026-10-09T12:00:00Z"), ref("c0ffee1", B, "2026-10-02T12:00:00Z")), "older");
  });

  test("the same commit is the same release; with no dates to go on it is unknown", () => {
    assert.equal(updateDirection(ref("1.2.0", A), ref("1.2.0", A)), "same");
    assert.equal(updateDirection(ref("b2c3d4e", A), ref("a1b2c3d", B)), "unknown");
    assert.equal(updateDirection(ref("b2c3d4e", A, "2026-10-09T12:00:00Z"), ref("a1b2c3d", B)), "unknown");
    assert.equal(updateDirection(ref("b2c3d4e", A, "not a date"), ref("a1b2c3d", B, "2026-10-01T12:00:00Z")), "unknown");
    // Equal versions on different commits, as a release republished: the dates, then unknown.
    assert.equal(updateDirection(ref("1.2.0", A, "2026-10-01T12:00:00Z"), ref("1.2.0", B, "2026-10-03T12:00:00Z")), "newer");
    assert.equal(updateDirection(ref("1.2.0", A), ref("1.2.0", B)), "unknown");
  });

  test("an older release, or one whose order can't be told, needs the admin to choose it", () => {
    assert.deepEqual(
      (["newer", "older", "same", "unknown"] as const).map(needsOlderConsent),
      [false, true, false, true],
    );
  });
});

describe("what changed in the folder", () => {
  const RELEASE = [
    file("app.json", '{\n  "name": "Board",\n  "lastUpdated": "2026-10-01T00:00:00.000Z"\n}\n'),
    file("api/items/route.ts", "export {};\n", 0o755),
    file("README.md", "# Board\n"),
    file("lib/old.ts", "export const old = 1;\n"),
  ];

  test("a folder as install wrote it has no local changes, found from the files hash alone", () => {
    const dir = folder(RELEASE);
    assert.deepEqual(folderState(dir, { filesHash: filesHash(RELEASE) }), {
      modified: false,
      folderHash: filesHash(RELEASE),
      unhashable: null,
    });
    const listed = localChangesBetween(dir, "app", RELEASE);
    assert.deepEqual([listed.changed, listed.added, listed.removed, listed.ignored], [[], [], [], []]);
  });

  test("names what changed, what was added and what was deleted, and nothing for modes or the record", () => {
    const dir = folder(RELEASE);
    fs.writeFileSync(path.join(dir, "README.md"), "# Board, edited\n");
    fs.writeFileSync(path.join(dir, "api/items/notes.ts"), "export const notes = true;\n");
    fs.rmSync(path.join(dir, "lib/old.ts"));
    // The record is never compared, and the execute bit install never writes doesn't count.
    fs.writeFileSync(path.join(dir, ".registry.json"), '{"edited": true}\n');
    fs.chmodSync(path.join(dir, "api/items/route.ts"), 0o644);

    const state = folderState(dir, { filesHash: filesHash(RELEASE) });
    assert.equal(state.modified, true);
    assert.notEqual(state.folderHash, null);
    assert.deepEqual(localChangesBetween(dir, "app", RELEASE), {
      changed: ["README.md"],
      added: ["api/items/notes.ts"],
      removed: ["lib/old.ts"],
      more: { changed: 0, added: 0, removed: 0 },
      ignored: [],
      incomplete: false,
    });
  });

  test("a manifest whose only change is lastUpdated, and git control files, are found and not listed", () => {
    const dir = folder(RELEASE);
    // The pre-commit stamp rewrote the date, and the layout with it.
    fs.writeFileSync(path.join(dir, "app.json"), '{"lastUpdated":"2026-10-11T09:30:00.000Z","name":"Board"}');
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
    fs.writeFileSync(path.join(dir, "lib/.GitAttributes"), "* -diff\n");

    assert.equal(folderState(dir, { filesHash: filesHash(RELEASE) }).modified, true);
    const listed = localChangesBetween(dir, "app", RELEASE);
    assert.deepEqual([listed.changed, listed.added, listed.removed], [[], [], []]);
    assert.deepEqual(listed.ignored, ["lastUpdated", "git-files"]);
  });

  test("a manifest change beyond lastUpdated is listed", () => {
    const dir = folder(RELEASE);
    fs.writeFileSync(path.join(dir, "app.json"), '{"name":"Board!","lastUpdated":"2026-10-11T09:30:00.000Z"}');
    assert.deepEqual(localChangesBetween(dir, "app", RELEASE).changed, ["app.json"]);
    assert.equal(onlyLastUpdated(Buffer.from('{"a":1,"lastUpdated":"x"}'), Buffer.from('{ "a": 1 }')), true);
    assert.equal(onlyLastUpdated(Buffer.from('{"a":1}'), Buffer.from('{"a":2}')), false);
    assert.equal(onlyLastUpdated(Buffer.from("not json"), Buffer.from("{}")), false);
  });

  test("a link install never writes counts as a change, and the folder has no files hash", () => {
    const dir = folder(RELEASE);
    fs.rmSync(path.join(dir, "README.md"));
    fs.symlinkSync("/etc/hosts", path.join(dir, "README.md"));
    fs.symlinkSync("/etc/hosts", path.join(dir, "hosts"));
    const state = folderState(dir, { filesHash: filesHash(RELEASE) });
    assert.deepEqual(state, {
      modified: true,
      folderHash: null,
      unhashable: "README.md is a symbolic link, which install never writes.",
    });
    // An update can't be made over it: nothing could tell later whether it changed.
    assert.equal(
      unhashableProblem("apps/board", state),
      "apps/board holds something no files hash covers (README.md is a symbolic link, which install never writes), " +
        "so an update couldn't tell later whether the folder changed. Take that out of the folder first.",
    );
    assert.equal(unhashableProblem("apps/board", { unhashable: null }), null);
    const listed = localChangesBetween(dir, "app", RELEASE);
    assert.deepEqual([listed.changed, listed.added], [["README.md"], ["hosts"]]);
  });

  test("long lists are cut, with how many more", () => {
    const dir = folder(RELEASE);
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `extra-${String(i).padStart(2, "0")}.ts`), "x\n");
    const listed = localChangesBetween(dir, "app", RELEASE);
    assert.equal(listed.added.length, 50);
    assert.equal(listed.more.added, 10);
    assert.equal(listed.added[0], "extra-00.ts");
  });
});

describe("what the release it goes to changes", () => {
  test("what the manifest declares: the rows that change, with what each adds and drops", () => {
    const before = {
      name: "Board",
      egress: ["api.example.com", "old.example.com"],
      env: [{ key: "BOARD_URL", label: "URL", type: "text" }],
      database: true,
      mcp: [{ name: "list_items" }],
    };
    const after = {
      name: "Board",
      egress: ["api.example.com", "files.example.com"],
      env: [
        { key: "BOARD_URL", label: "URL", type: "text" },
        { key: "BOARD_TOKEN", label: "Token", type: "password" },
      ],
      database: true,
      mcp: [{ name: "list_items" }],
      consumes: [{ app: "files", service: "upload" }],
    };
    assert.deepEqual(compareDeclarations("app", before, after), [
      { label: "Egress", added: ["files.example.com"], removed: ["old.example.com"] },
      { label: "Env", added: ["BOARD_TOKEN (secret)"], removed: [] },
      { label: "Services", added: ["uses files/upload"], removed: [] },
    ]);
    assert.deepEqual(compareDeclarations("app", before, before), []);
    // A database the new release no longer has.
    assert.deepEqual(compareDeclarations("app", { database: true }, {}), [
      { label: "Database", added: [], removed: ["Its own schema and database role"] },
    ]);
  });

  test("a connector's hosts and credentials", () => {
    const before = { http: { baseUrl: "https://api.example.com" }, credentialFields: [{ key: "apiKey" }] };
    const after = {
      http: { baseUrl: "https://api.example.net" },
      credentialFields: [{ key: "apiKey" }, { key: "region" }],
      webhook: { secretField: "signingSecret" },
    };
    assert.deepEqual(compareDeclarations("connector", before, after), [
      { label: "Hosts it reaches", added: ["api.example.net"], removed: ["api.example.com"] },
      { label: "Credentials an admin enters", added: ["region"], removed: [] },
      { label: "Webhooks", added: ["Receives signed webhooks"], removed: [] },
    ]);
  });

  test("the publisher's claims, by scope, made fit to show", () => {
    const before = shownClaims([
      { scope: "network:api.example.com", reason: "Reads items." },
      { scope: "network:old.example.com", reason: "Reads old items." },
    ]);
    const after = shownClaims([
      { scope: "network:api.example.com", reason: "Reads and writes items." },
      { scope: "network:files.example.com", reason: "Uploads‮ files." },
      { scope: "network:files.example.com", reason: "A second claim of one scope is dropped." },
    ]);
    assert.deepEqual(compareClaims(before, after), {
      added: [{ scope: "network:files.example.com", reason: "Uploads files." }],
      removed: [{ scope: "network:old.example.com", reason: "Reads old items." }],
      changed: [{ scope: "network:api.example.com", reason: "Reads and writes items." }],
    });
  });

  test("migrations: new ones, changed ones, and the ones the release lacks", () => {
    const dir = folder([
      file("migrations/0001_items.sql", "create table items (id int);\n"),
      file("migrations/0002_tags.sql", "create table tags (id int);\n"),
      file("migrations/notes.txt", "not a migration\n"),
    ]);
    const release = releaseMigrations([
      file("migrations/0001_items.sql", "create table items (id bigint);\n"),
      file("migrations/0003_pins.sql", "create table pins (id int);\n"),
      file("migrations/nested/0004.sql", "not applied: not directly in migrations/\n"),
      file("app.json", "{}"),
    ]);
    assert.deepEqual(compareMigrations(folderMigrations(dir), release), {
      added: ["0003_pins.sql"],
      changed: ["0001_items.sql"],
      lacking: ["0002_tags.sql"],
    });
    assert.deepEqual(compareMigrations(folderMigrations(path.join(tmp, "nowhere")), new Map()), {
      added: [],
      changed: [],
      lacking: [],
    });
  });
});

describe("one folder against another", () => {
  test("what a commit of one in the other's place changes: the files changed, added and deleted, the record included", () => {
    const before = folder([file("app.json", '{"name":"A"}\n'), file("api/a/route.ts", "a\n"), file("old.ts", "old\n")]);
    const after = folder([file("app.json", '{"name":"A"}\n'), file("api/a/route.ts", "b\n"), file("new.ts", "new\n")]);
    fs.writeFileSync(path.join(after, ".registry.json"), '{"version":"2"}\n');
    assert.deepEqual(folderDifferences(before, after), {
      changed: [".registry.json", "api/a/route.ts"],
      added: ["new.ts"],
      removed: ["old.ts"],
      more: { changed: 0, added: 0, removed: 0 },
      incomplete: false,
    });
    assert.deepEqual(folderDifferences(before, before).changed, []);
  });

  test("a link in a file's place counts as changed, and is never read through", () => {
    const before = folder([file("README.md", "hello\n"), file("app.json", "{}\n")]);
    const after = folder([file("app.json", "{}\n")]);
    fs.symlinkSync(path.join(before, "README.md"), path.join(after, "README.md"));
    assert.deepEqual(folderDifferences(before, after).changed, ["README.md"]);
  });

  test("long lists are cut, with how many more", () => {
    const before = folder([file("app.json", "{}\n")]);
    const after = folder([
      file("app.json", "{}\n"),
      ...Array.from({ length: 53 }, (_, i) => file(`f${String(i).padStart(2, "0")}.ts`, "x\n")),
    ]);
    const changes = folderDifferences(before, after);
    assert.equal(changes.added.length, 50);
    assert.equal(changes.more.added, 3);
  });

  test("a theme's manifest whose only change is lastUpdated isn't a local change", () => {
    const manifest = (extra: Record<string, unknown>) => `${JSON.stringify({ name: "Dusk", ...extra }, null, 2)}\n`;
    const release = [file("theme.json", manifest({})), file("theme.css", ":root {}\n")];
    const dir = folder([file("theme.json", manifest({ lastUpdated: "2026-10-11T09:00:00.000Z" })), file("theme.css", ":root {}\n")]);
    const local = localChangesBetween(dir, "theme", release);
    assert.deepEqual([local.changed, local.ignored], [[], ["lastUpdated"]]);
  });

  test("a migration with no bytes to compare on either side counts as changed", () => {
    const sql = Buffer.from("create table t (id int);\n");
    assert.deepEqual(compareMigrations(new Map([["0001.sql", sql]]), new Map([["0001.sql", null]])).changed, ["0001.sql"]);
    assert.deepEqual(compareMigrations(new Map([["0001.sql", sql]]), new Map([["0001.sql", sql]])).changed, []);
  });

  test("two repositories are one when GitHub would say so", () => {
    assert.equal(sameRepository({ owner: "Acme", name: "Board" }, { owner: "acme", name: "board" }), true);
    assert.equal(sameRepository({ owner: "acme", name: "board" }, { owner: "mallory", name: "board" }), false);
  });
});
