/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The registry generator and install records: scanRegistryInstalls() lists
 * the accepted extensions installed from a Registry, says which no longer
 * match their record, and warns about records it can't use;
 * checkInstalledFloors() fails the build on one that needs a newer MixOS; and
 * a record in a folder changes nothing else the generator, or an install's
 * check, does.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesHash, hashFileTree } from "../src/lib/repository/content-hash";
import {
  INSTALL_RECORD_FILE,
  serializeInstallRecord,
  type InstallRecord,
} from "../src/lib/repository/install-record";
import type { TarEntry } from "../src/lib/repository/tar";
import {
  checkInstalledFloors,
  checkStaged,
  readRegistered,
  scanApps,
  scanConnectors,
  scanRegistryInstalls,
  scanThemes,
} from "./generate-project-registry";

const ROOT = path.resolve(__dirname, "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-registry-installs-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const file = (p: string, data: string): TarEntry => ({ path: p, mode: 0o644, data: Buffer.from(data) });
const FILES = [file("app.json", '{"name":"Files"}\n'), file("README.md", "# Files\n")];

function record(fields: Partial<InstallRecord> = {}, entries: TarEntry[] = FILES): InstallRecord {
  return {
    source: "https://mixos.org",
    kind: "app",
    slug: "files",
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "c".repeat(40),
    contentHash: hashFileTree(entries),
    filesHash: filesHash(entries),
    repository: { owner: "acme", name: "mixos-files", subpath: null },
    requiresMixOS: "0.1.0",
    ...fields,
  };
}

/** An extension folder `name` holding `entries`, and `recordText` as its .registry.json when given. */
function folder(name: string, entries: TarEntry[] = FILES, recordText?: string): string {
  const dir = path.join(tmp, `ext-${n++}`, name);
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, e.path), e.data);
  }
  if (recordText !== undefined) fs.writeFileSync(path.join(dir, INSTALL_RECORD_FILE), recordText);
  return dir;
}

describe("scanRegistryInstalls", () => {
  test("lists an extension with a record of its own, as the record says, and not modified", () => {
    const dir = folder("files", FILES, serializeInstallRecord(record()));
    const { installs, warnings } = scanRegistryInstalls([{ kind: "app", slug: "files", dir }]);
    assert.deepEqual(installs, [
      {
        kind: "app",
        slug: "files",
        version: "1.2.0",
        gitTag: "v1.2.0",
        commitSha: "c".repeat(40),
        source: "https://mixos.org",
        repository: { owner: "acme", name: "mixos-files", subpath: null },
        requiresMixOS: "0.1.0",
        modified: false,
      },
    ]);
    assert.deepEqual(warnings, []);
  });

  test("a folder with no record is local: not listed, and nothing to say", () => {
    const dir = folder("wall-e", FILES);
    assert.deepEqual(scanRegistryInstalls([{ kind: "app", slug: "wall-e", dir }]), { installs: [], warnings: [] });
  });

  test("an edited, added or removed file makes it modified locally, and says so", () => {
    const dir = folder("files", FILES, serializeInstallRecord(record()));
    fs.appendFileSync(path.join(dir, "README.md"), "Edited here.\n");
    const { installs, warnings } = scanRegistryInstalls([{ kind: "app", slug: "files", dir }]);
    assert.equal(installs[0].modified, true);
    assert.match(warnings.join("\n"), /apps\/files\/ no longer matches its \.registry\.json: its files changed after 1\.2\.0 from mixos\.org was installed/);

    const added = folder("files", FILES, serializeInstallRecord(record()));
    fs.writeFileSync(path.join(added, "extra.ts"), "export {};\n");
    assert.equal(scanRegistryInstalls([{ kind: "app", slug: "files", dir: added }]).installs[0].modified, true);
  });

  test("Finder's .DS_Store counts as a change, and the warning says it is only that", () => {
    const dir = folder("files", FILES, serializeInstallRecord(record()));
    fs.writeFileSync(path.join(dir, ".DS_Store"), Buffer.from([0, 0, 0, 1]));
    const { installs, warnings } = scanRegistryInstalls([{ kind: "app", slug: "files", dir }]);
    assert.equal(installs[0].modified, true);
    assert.match(warnings.join("\n"), /differs from its \.registry\.json only by \.DS_Store files.*find apps\/files -name \.DS_Store -delete/);
  });

  test("a record that can't be read, or names another kind or slug, is a warning, and the extension is local", () => {
    const bad = folder("files", FILES, "{ not json");
    const other = folder("files", FILES, serializeInstallRecord(record({ slug: "other" })));
    const kind = folder("files", FILES, serializeInstallRecord(record({ kind: "connector" })));
    const { installs, warnings } = scanRegistryInstalls([
      { kind: "app", slug: "files", dir: bad },
      { kind: "app", slug: "files", dir: other },
      { kind: "app", slug: "files", dir: kind },
    ]);
    assert.deepEqual(installs, []);
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /apps\/files\/\.registry\.json can't be read \(it is not JSON\), so apps\/files\/ is treated as a local extension/);
    assert.match(warnings[1], /isn't this folder's: it records app\/other, not app\/files/);
    assert.match(warnings[2], /it records connector\/files, not app\/files/);
  });

  test("a record from a catalogue other than mixos.org is listed, with a warning", () => {
    const dir = folder("files", FILES, serializeInstallRecord(record({ source: "http://127.0.0.1:4388" })));
    const { installs, warnings } = scanRegistryInstalls([{ kind: "app", slug: "files", dir }]);
    assert.equal(installs[0].source, "http://127.0.0.1:4388");
    assert.match(warnings.join("\n"), /apps\/files\/ was installed from http:\/\/127\.0\.0\.1:4388, not https:\/\/mixos\.org/);
  });

  test("every kind, in kind then slug order", () => {
    const theme = [file("theme.json", "{}\n")];
    const crm = [file("connector.json", "{}\n")];
    const { installs } = scanRegistryInstalls([
      { kind: "theme", slug: "dusk", dir: folder("dusk", theme, serializeInstallRecord(record({ kind: "theme", slug: "dusk" }, theme))) },
      { kind: "app", slug: "zeta", dir: folder("zeta", FILES, serializeInstallRecord(record({ slug: "zeta" }))) },
      { kind: "connector", slug: "crm", dir: folder("crm", crm, serializeInstallRecord(record({ kind: "connector", slug: "crm" }, crm))) },
      { kind: "app", slug: "files", dir: folder("files", FILES, serializeInstallRecord(record())) },
    ]);
    assert.deepEqual(installs.map((i) => `${i.kind}/${i.slug}:${i.modified}`), [
      "app/files:false",
      "app/zeta:false",
      "connector/crm:false",
      "theme/dusk:false",
    ]);
  });
});

describe("checkInstalledFloors: requiresMixOS at build", () => {
  /** What scanRegistryInstalls() lists for a vendored folder whose record has `floor`. */
  const listed = (slug: string, floor: string | null, kind: InstallRecord["kind"] = "app") =>
    scanRegistryInstalls([
      { kind, slug, dir: folder(slug, FILES, serializeInstallRecord(record({ kind, slug, requiresMixOS: floor }))) },
    ]).installs;

  test("a floor above the build's version fails it, naming the extension, its floor and the version", () => {
    const { error, warnings } = checkInstalledFloors(listed("files", "0.2.0"), "0.1.0");
    assert.equal(
      error,
      "This build is MixOS 0.1.0, and an extension installed from a Registry needs a newer one:\n" +
        "  apps/files/.registry.json: release 1.2.0 requires MixOS 0.2.0 or newer.\n" +
        "Upgrade MixOS, or install an older release of it that runs on 0.1.0. " +
        "The build stops rather than leave it out of this deploy.",
    );
    assert.deepEqual(warnings, []);
  });

  test("every extension that needs a newer MixOS is named, of every kind", () => {
    const { error } = checkInstalledFloors(
      [...listed("files", "0.2.0"), ...listed("met", "0.1.0"), ...listed("crm", "v1.0", "connector")],
      "0.1.0",
    );
    assert.match(error ?? "", /^This build is MixOS 0\.1\.0, and 2 extensions installed from a Registry need a newer one:\n/);
    assert.match(error ?? "", /^ {2}apps\/files\/\.registry\.json: release 1\.2\.0 requires MixOS 0\.2\.0 or newer\.$/m);
    assert.match(error ?? "", /^ {2}connectors\/crm\/\.registry\.json: release 1\.2\.0 requires MixOS v1\.0 or newer\.$/m);
    assert.doesNotMatch(error ?? "", /apps\/met/);
    assert.match(error ?? "", /install an older release of each that runs on 0\.1\.0\. The build stops rather than leave them out/);
  });

  test("a floor at or below the build's version, or none, passes", () => {
    for (const floor of ["0.1.0", "0.0.9", ">=0.1", "v0.1.0", "0.1.0-beta.2", null]) {
      assert.deepEqual(checkInstalledFloors(listed("files", floor), "0.1.0"), { error: null, warnings: [] }, String(floor));
    }
  });

  test("a version bumped locally on unreleased work lets the coming release's floor through", () => {
    const installs = listed("files", "0.2.0");
    assert.notEqual(checkInstalledFloors(installs, "0.1.0").error, null);
    assert.deepEqual(checkInstalledFloors(installs, "0.2.0"), { error: null, warnings: [] });
    assert.deepEqual(checkInstalledFloors(installs, "0.2.0-rc.1"), { error: null, warnings: [] });
  });

  test("a floor that isn't a version passes with a warning, as install lets it through", () => {
    const { error, warnings } = checkInstalledFloors(listed("files", "soon"), "0.1.0");
    assert.equal(error, null);
    assert.deepEqual(warnings, [
      'apps/files/.registry.json: requiresMixOS "soon" isn\'t a version, so it isn\'t checked, here or at install.',
    ]);
  });

  test("a local extension has no record, so nothing about it is checked", () => {
    // The same folder without its record, beside one with a floor no build meets.
    const local = folder("wall-e", FILES);
    const vendored = folder("files", FILES, serializeInstallRecord(record({ requiresMixOS: "999.0.0" })));
    const { installs } = scanRegistryInstalls([
      { kind: "app", slug: "wall-e", dir: local },
      { kind: "app", slug: "files", dir: vendored },
    ]);
    const { error } = checkInstalledFloors(installs, "0.1.0");
    assert.match(error ?? "", /apps\/files\/\.registry\.json: release 1\.2\.0 requires MixOS 999\.0\.0 or newer/);
    assert.doesNotMatch(error ?? "", /wall-e/);
    assert.deepEqual(checkInstalledFloors(scanRegistryInstalls([{ kind: "app", slug: "wall-e", dir: local }]).installs, "0.1.0"), {
      error: null,
      warnings: [],
    });
  });
});

describe("a record in a folder changes nothing else", () => {
  const RECORD_TEXT = (kind: InstallRecord["kind"], slug: string) =>
    serializeInstallRecord(record({ kind, slug, contentHash: filesHash([]), filesHash: filesHash([]) }));

  test("the scans read the same extension with it as without", async (t) => {
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "warn", () => {});
    const apps = path.join(tmp, `apps-${n++}`);
    for (const [name, withRecord] of [["acme", true], ["plain", false]] as const) {
      fs.mkdirSync(path.join(apps, name), { recursive: true });
      fs.writeFileSync(path.join(apps, name, "app.json"), JSON.stringify({ name: "Acme" }));
      fs.writeFileSync(path.join(apps, name, "README.md"), "# Acme\n");
      if (withRecord) fs.writeFileSync(path.join(apps, name, INSTALL_RECORD_FILE), RECORD_TEXT("app", name));
    }
    const scanned = await scanApps(apps, { emit: false });
    const acme = scanned.find((m) => m.slug === "acme");
    const plain = scanned.find((m) => m.slug === "plain");
    assert.ok(acme && plain);
    assert.deepEqual({ ...acme, slug: "plain" }, plain);

    const connectors = path.join(tmp, `connectors-${n++}`);
    fs.cpSync(path.join(ROOT, "connectors", "_template"), path.join(connectors, "probe-conn"), { recursive: true });
    const manifest = path.join(connectors, "probe-conn", "connector.json");
    fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, "utf8")), name: "probe-conn" }));
    const before = await scanConnectors(connectors, { emit: false });
    fs.writeFileSync(path.join(connectors, "probe-conn", INSTALL_RECORD_FILE), RECORD_TEXT("connector", "probe-conn"));
    assert.deepEqual(await scanConnectors(connectors, { emit: false }), before);

    const themes = path.join(tmp, `themes-${n++}`);
    fs.cpSync(path.join(ROOT, "themes", "_template"), path.join(themes, "probe-theme"), { recursive: true });
    const beforeThemes = await scanThemes(themes, { emit: false });
    fs.writeFileSync(path.join(themes, "probe-theme", INSTALL_RECORD_FILE), RECORD_TEXT("theme", "probe-theme"));
    assert.deepEqual(await scanThemes(themes, { emit: false }), beforeThemes);
  });

  test("an install's check accepts a staged copy holding the record install wrote, for each kind", async () => {
    const registry = path.join(tmp, `registry-${n++}`);
    fs.mkdirSync(registry);
    fs.writeFileSync(path.join(registry, "app-registry.ts"), "export const appRegistry = [];\n");
    fs.writeFileSync(path.join(registry, "connector-registry.ts"), "export const connectorRegistry = [];\n");
    const registered = readRegistered(registry);

    const app = path.join(tmp, `stage-${n++}`, "acme");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "app.json"), JSON.stringify({ name: "Acme" }));
    fs.writeFileSync(path.join(app, INSTALL_RECORD_FILE), RECORD_TEXT("app", "acme"));
    assert.deepEqual(await checkStaged("app", app, registered), { problems: [], deferred: [] });

    const connector = path.join(tmp, `stage-${n++}`, "probe-conn");
    fs.cpSync(path.join(ROOT, "connectors", "_template"), connector, { recursive: true });
    const manifest = path.join(connector, "connector.json");
    fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, "utf8")), name: "probe-conn" }));
    fs.writeFileSync(path.join(connector, INSTALL_RECORD_FILE), RECORD_TEXT("connector", "probe-conn"));
    assert.deepEqual(await checkStaged("connector", connector, registered), { problems: [], deferred: [] });

    const theme = path.join(tmp, `stage-${n++}`, "probe-theme");
    fs.cpSync(path.join(ROOT, "themes", "_template"), theme, { recursive: true });
    fs.writeFileSync(path.join(theme, INSTALL_RECORD_FILE), RECORD_TEXT("theme", "probe-theme"));
    assert.deepEqual(await checkStaged("theme", theme, registered), { problems: [], deferred: [] });
  });
});
