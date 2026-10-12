/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pull-request check that every installed folder matches its
 * `.registry.json` (scripts/check-install-records.ts), over checkouts made
 * here: a match, an edit, a file missing from the commit, a record that isn't
 * one or isn't this folder's, a link, and the folders it leaves alone.
 */

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesHash } from "../src/lib/repository/content-hash";
import { INSTALL_RECORD_FILE, serializeInstallRecord, type InstallRecord } from "../src/lib/repository/install-record";
import type { TarEntry } from "../src/lib/repository/tar";
import type { ExtensionKind } from "../src/lib/repository/types";
import { checkInstallRecords, formatRecordCheck } from "./check-install-records";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-check-records-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
let root: string;
beforeEach(() => {
  root = path.join(tmp, `checkout-${n++}`);
  fs.mkdirSync(root);
});

const DIR: Record<ExtensionKind, string> = { app: "apps", connector: "connectors", theme: "themes" };

const TREE: TarEntry[] = [
  { path: "app.json", mode: 0o644, data: Buffer.from('{ "name": "Files" }\n') },
  { path: "api/files/route.ts", mode: 0o644, data: Buffer.from("export {};\n") },
  { path: "assets/ca.pem", mode: 0o644, data: Buffer.from("-----BEGIN CERTIFICATE-----\n") },
];

function record(kind: ExtensionKind, slug: string, tree: TarEntry[]): InstallRecord {
  return {
    source: "https://mixos.org",
    kind,
    slug,
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "c".repeat(40),
    contentHash: filesHash(tree),
    filesHash: filesHash(tree),
    repository: { owner: "acme", name: `mixos-${slug}`, subpath: null },
    requiresMixOS: null,
  };
}

/** A folder as install writes one: the files, and the record of them. */
function installed(kind: ExtensionKind, slug: string, tree: TarEntry[] = TREE, recorded = record(kind, slug, tree)): string {
  const dir = path.join(root, DIR[kind], slug);
  for (const e of tree) {
    fs.mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, e.path), e.data);
  }
  fs.writeFileSync(path.join(dir, INSTALL_RECORD_FILE), serializeInstallRecord(recorded));
  return dir;
}

describe("installed folders", () => {
  test("every kind's folder that matches its record passes; a folder with no record isn't checked", () => {
    installed("app", "files");
    installed("connector", "crm");
    installed("theme", "dusk");
    fs.mkdirSync(path.join(root, "apps", "local", "api"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", "local", "app.json"), "{}\n");
    fs.writeFileSync(path.join(root, "apps", "AGENTS.md"), "# Apps\n");

    const result = checkInstallRecords(root);
    assert.deepEqual(result, { checked: ["apps/files", "connectors/crm", "themes/dusk"], problems: [] });
    assert.deepEqual(formatRecordCheck(result), [
      "3 installed folder(s) match their .registry.json: apps/files, connectors/crm, themes/dusk.",
    ]);
  });

  test("an edited file fails, naming the folder, the release and how to fix it", () => {
    const dir = installed("app", "files");
    fs.appendFileSync(path.join(dir, "api/files/route.ts"), "// edited\n");
    const { problems } = checkInstallRecords(root);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].folder, "apps/files");
    assert.match(
      problems[0].problem,
      /^apps\/files\/ doesn't match its \.registry\.json\. Its files changed after 1\.2\.0 from mixos\.org was installed, or one is missing from the commit\. Compare it with the release: https:\/\/github\.com\/acme\/mixos-files\/tree\/c{40}$/,
    );
    assert.match(problems[0].fixes.join("\n"), /git add -f <file>/);
    assert.match(problems[0].fixes.join("\n"), /install the release again/);
    assert.match(problems[0].fixes.join("\n"), /delete apps\/files\/\.registry\.json to keep your changes as a local extension/);
  });

  test("a file missing from the checkout fails: what .gitignore kept out of the commit counts", () => {
    const dir = installed("app", "files");
    fs.rmSync(path.join(dir, "assets/ca.pem"));
    assert.deepEqual(checkInstallRecords(root).problems.map((p) => p.folder), ["apps/files"]);
  });

  test("a file added, even a .DS_Store, fails; the record itself is never counted", () => {
    const dir = installed("app", "files");
    fs.writeFileSync(path.join(dir, INSTALL_RECORD_FILE), `${fs.readFileSync(path.join(dir, INSTALL_RECORD_FILE), "utf8")}\n`);
    assert.deepEqual(checkInstallRecords(root).problems, [], "rewriting the record changes nothing it hashes");
    fs.writeFileSync(path.join(dir, "api/.DS_Store"), "x");
    assert.deepEqual(checkInstallRecords(root).problems.map((p) => p.folder), ["apps/files"]);
  });

  test("a link in the folder fails, saying what it is", () => {
    const dir = installed("app", "files");
    fs.symlinkSync("app.json", path.join(dir, "link.json"));
    const [problem] = checkInstallRecords(root).problems;
    assert.match(problem.problem, /doesn't match its \.registry\.json\. link\.json is a symbolic link, which install never writes\./);
  });

  test("a record that isn't one, or isn't this folder's, fails with the two ways out", () => {
    const bad = installed("connector", "crm");
    fs.writeFileSync(path.join(bad, INSTALL_RECORD_FILE), "{ not json");
    installed("app", "files", TREE, record("app", "other", TREE));
    installed("theme", "dusk", TREE, record("app", "dusk", TREE));

    const { problems } = checkInstallRecords(root);
    assert.deepEqual(
      problems.map((p) => p.problem),
      [
        "apps/files/.registry.json isn't this folder's: it records app/other, not app/files.",
        "connectors/crm/.registry.json can't be read as an install record: it is not JSON.",
        "themes/dusk/.registry.json isn't this folder's: it records app/dusk, not theme/dusk.",
      ],
    );
    for (const p of problems) {
      assert.deepEqual(p.fixes, [
        "Install the extension again from the Registry, which writes a new record.",
        `Or delete ${p.folder}/.registry.json to keep the folder as a local extension.`,
      ]);
    }
  });

  test("templates and set-aside folders are skipped, as the registry generator skips them", () => {
    for (const slug of ["_template", ".old-files"]) {
      const dir = installed("app", slug === "_template" ? "files" : "files2");
      fs.renameSync(dir, path.join(root, "apps", slug));
      fs.appendFileSync(path.join(root, "apps", slug, "app.json"), "edited\n");
    }
    assert.deepEqual(checkInstallRecords(root), { checked: [], problems: [] });
  });

  test("the report: each problem with its fixes, then a count", () => {
    const dir = installed("app", "files");
    installed("app", "notes");
    fs.appendFileSync(path.join(dir, "app.json"), "\n");
    const lines = formatRecordCheck(checkInstallRecords(root));
    assert.match(lines[0], /^apps\/files\/ doesn't match/);
    assert.match(lines[1], /^ {2}Commit the missing file/);
    assert.equal(lines[lines.length - 1], "1 of 2 installed folder(s) don't match their .registry.json.");
    assert.deepEqual(formatRecordCheck({ checked: [], problems: [] }), [
      "No folder in apps/, connectors/ or themes/ was installed from a Registry.",
    ]);
  });
});

describe("the command", () => {
  test("in this checkout, which installed nothing from a Registry, it exits 0", () => {
    const repo = path.resolve(__dirname, "..");
    const run = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "check-install-records.ts")], {
      cwd: repo,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});
