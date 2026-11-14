/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RawAppManifestSchema, RemixEntrySchema } from "./manifest-schemas";
import { checkLatestRemix, creditComment, pinSource } from "./remix";
import { folderFilesHash, serializeInstallRecord } from "../src/lib/repository/install-record";

const roots: string[] = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** A checkout with a source app (careers) and a target app (deals), both committed. */
function checkout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-remix-"));
  roots.push(root);
  write(root, "apps/careers/app.json", JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", name: "Career", license: "MPL-2.0" }));
  write(root, "apps/careers/pages/Main.tsx", "export default function Main() { return null; }\n");
  write(root, "apps/careers/widgets/application-pipeline.tsx", "export default function W() { return null; }\n");
  write(root, "apps/careers/api/applications/[id]/route.ts", "export const PATCH = 1;\nexport const DELETE = 2;\n");
  write(root, "apps/deals/app.json", JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", name: "Deals", license: "MPL-2.0" }));
  write(root, "apps/deals/pages/deals.tsx", 'export const href = "/apps/deals/42";\n');
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base");
  return root;
}

function entryFor(root: string, overrides: Record<string, unknown> = {}) {
  const pinned = pinSource(root, "careers", "deals");
  return {
    remixedAt: "2026-10-16",
    source: { ...pinned.source, anchors: ["page:/", "route:PATCH /applications/[id]"] },
    summary: "Table of items with a status on each row",
    keywords: ["status-table", "inline-status"],
    license: { spdx: pinned.license.source, mode: pinned.license.mode },
    actions: { "change-status": "same", delete: "remove" },
    hiddenRules: { "applied-date-stamp": "same" },
    partsRemoved: [],
    landedIn: ["pages/deals.tsx"],
    ...overrides,
  };
}

/** Puts the remix credit at the top of a landed file, as the agent does. */
function credit(root: string, rel: string): void {
  const file = path.join(root, "apps/deals", rel);
  const comment = creditComment(rel, pinSource(root, "careers", "deals", "2026-10-16").credit.lines);
  fs.writeFileSync(file, `${comment}\n${fs.readFileSync(file, "utf8")}`);
}

function record(root: string, entries: unknown[]): void {
  const file = path.join(root, "apps/deals/app.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...manifest, remixedFrom: entries }, null, 2));
}

// ── source ──────────────────────────────────────────────────────────────────

test("a committed source records the last commit that touched its folder", () => {
  const root = checkout();
  const pinned = pinSource(root, "careers", "deals");
  assert.deepEqual(pinned.source, {
    app: "careers",
    commitSha: git(root, "rev-parse", "HEAD"),
    commitFrom: "git",
    modified: false,
    registry: null,
  });
  assert.equal(pinned.license.mode, "adapted");
});

test("uncommitted changes in the source mark it modified", () => {
  const root = checkout();
  write(root, "apps/careers/pages/Main.tsx", "export default function Main() { return 1; }\n");
  assert.equal(pinSource(root, "careers", "deals").source.modified, true);
});

test("a source that was never committed has no commit, and is modified", () => {
  const root = checkout();
  write(root, "apps/fresh/app.json", JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", name: "Fresh" }));
  const pinned = pinSource(root, "fresh", "deals");
  assert.equal(pinned.source.commitSha, null);
  assert.equal(pinned.source.modified, true);
  assert.equal(pinned.license.mode, "rebuilt");
});

test("an installed source records its install record's commit and listing", () => {
  const root = checkout();
  const dir = path.join(root, "apps/careers");
  const commitSha = "a".repeat(40);
  const rec = {
    source: "https://mixos.org",
    kind: "app" as const,
    slug: "careers",
    version: "1.4.0",
    gitTag: "v1.4.0",
    commitSha,
    contentHash: `sha256-${"A".repeat(43)}=`,
    filesHash: folderFilesHash(dir),
    repository: { owner: "acme", name: "mixos-careers", subpath: null },
    requiresMixOS: null,
  };
  write(root, "apps/careers/.registry.json", serializeInstallRecord(rec));
  assert.deepEqual(pinSource(root, "careers", "deals").source, {
    app: "careers",
    commitSha,
    commitFrom: "install-record",
    modified: false,
    registry: { origin: "https://mixos.org", slug: "careers", version: "1.4.0" },
  });

  // Edited after install: still the record's commit, now modified.
  write(root, "apps/careers/pages/Main.tsx", "export default function Main() { return 2; }\n");
  const edited = pinSource(root, "careers", "deals").source;
  assert.equal(edited.commitSha, commitSha);
  assert.equal(edited.modified, true);
});

test("a source can't be its own target", () => {
  const root = checkout();
  assert.throws(() => pinSource(root, "deals", "deals"), /same app/);
});

// ── the manifest schema ─────────────────────────────────────────────────────

test("a well-formed entry passes the manifest schema", () => {
  const root = checkout();
  const parsed = RawAppManifestSchema.safeParse({
    $schema: "https://mixos.org/schemas/app/v1.json",
    registryId: "deals-3f9a2c1b",
    name: "Deals",
    remixedFrom: [entryFor(root)],
  });
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("the schema refuses a malformed entry", () => {
  const root = checkout();
  const bad = (overrides: Record<string, unknown>) => RemixEntrySchema.safeParse(entryFor(root, overrides)).success;
  const source = entryFor(root).source;
  assert.equal(bad({ keywords: ["one"] }), false);
  assert.equal(bad({ keywords: ["a1", "b2", "c3", "d4", "e5", "f6"] }), false);
  assert.equal(bad({ keywords: ["Status Table", "x1"] }), false);
  assert.equal(bad({ keywords: ["same-one", "same-one"] }), false);
  assert.equal(bad({ source: { ...source, anchors: ["route:PATCH /applications/[id]"] } }), false);
  assert.equal(bad({ source: { ...source, anchors: ["table:roles"] } }), false);
  assert.equal(bad({ source: { ...source, commitSha: "abc123" } }), false);
  assert.equal(bad({ source: { ...source, commitSha: null, modified: false } }), false);
  assert.equal(bad({ source: { ...source, commitFrom: "install-record" } }), false);
  assert.equal(bad({ actions: { "change-status": "keep" } }), false);
  assert.equal(bad({ license: { spdx: null, mode: "adapted" } }), false);
  assert.equal(bad({ license: { spdx: "UNLICENSED", mode: "adapted" } }), false);
  assert.equal(bad({ landedIn: ["../careers/pages/Main.tsx"] }), false);
  assert.equal(bad({ landedIn: ["/etc/passwd"] }), false);
  assert.equal(bad({ remixedAt: "16 Oct 2026" }), false);
});

test("the schema accepts landed files that have since moved — it checks shape, not history", () => {
  const root = checkout();
  assert.equal(RemixEntrySchema.safeParse(entryFor(root, { landedIn: ["pages/renamed-since.tsx"] })).success, true);
});

// ── check ───────────────────────────────────────────────────────────────────

test("a remix recorded as the moment it happened checks out", () => {
  const root = checkout();
  record(root, [entryFor(root)]);
  credit(root, "pages/deals.tsx");
  assert.deepEqual(checkLatestRemix(root, "deals"), []);
});

test("every landed file credits the source: its name, version, authors and the day", () => {
  const root = checkout();
  write(
    root,
    "apps/careers/app.json",
    JSON.stringify({ name: "Careers", license: "MPL-2.0", authors: [{ name: "Ada Lovelace", email: "ada@example.com" }] }),
  );
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "authors");
  const commit = git(root, "log", "-1", "--format=%H").trim();
  const { credit: c } = pinSource(root, "careers", "deals", "2026-10-16");
  assert.deepEqual(c.lines, [
    `Remixed from Careers (careers) commit ${commit.slice(0, 7)}, by Ada Lovelace, on 2026-10-16.`,
    "Derivative work: adapted from its code, which is MPL-2.0.",
  ]);
  assert.equal(creditComment("api/x/route.ts", ["a", "b"]), "// a\n// b");
  assert.equal(creditComment("migrations/0001.sql", ["a"]), "-- a");
  assert.equal(creditComment("app.json", ["a"]), null);

  record(root, [entryFor(root)]);
  assert.match(checkLatestRemix(root, "deals").join("\n"), /pages\/deals\.tsx doesn't carry the remix credit[\s\S]*\/\/ Remixed from Careers/);
  credit(root, "pages/deals.tsx");
  assert.deepEqual(checkLatestRemix(root, "deals"), []);
});

test("check finds what doesn't hold at the moment of the remix", () => {
  const root = checkout();
  write(root, "apps/deals/pages/linked.tsx", 'export const back = "/apps/careers/library";\n');
  write(root, "apps/deals/api/x.ts", 'createAppClient("careers");\n');
  const base = entryFor(root);
  record(root, [
    entryFor(root, {
      source: { ...base.source, commitSha: "b".repeat(40), anchors: ["widget:nope", "route:PUT /applications/[id]"] },
      keywords: ["dnd", "page"],
      landedIn: ["pages/deals.tsx", "pages/linked.tsx", "api/x.ts", "pages/missing.tsx"],
    }),
  ]);
  const problems = checkLatestRemix(root, "deals").join("\n");
  assert.match(problems, /source\.commitSha/);
  assert.match(problems, /widgets\/ has no widget "nope"/);
  assert.match(problems, /declares no PUT/);
  assert.match(problems, /keyword "dnd" is recorded as "drag-and-drop"/);
  assert.match(problems, /keyword "page" says nothing/);
  assert.match(problems, /pages\/linked\.tsx has a link to \/apps\/careers/);
  assert.match(problems, /api\/x\.ts has createAppClient\("careers"\)/);
  assert.match(problems, /pages\/missing\.tsx doesn't exist/);
});

test("check refuses an adapted remix the license doesn't allow", () => {
  const root = checkout();
  write(root, "apps/careers/app.json", JSON.stringify({ $schema: "https://mixos.org/schemas/app/v1.json", name: "Career", license: "GPL-3.0-only" }));
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "gpl");
  record(root, [entryFor(root, { license: { spdx: "GPL-3.0-only", mode: "adapted" } })]);
  assert.match(checkLatestRemix(root, "deals").join("\n"), /must be rebuilt/);
});

// ── the pre-commit guard ────────────────────────────────────────────────────

test("the pre-commit guard refuses an edited entry, and passes additions and deletions", async () => {
  const { stagedRemixEdits } = await import("./check-remix-provenance");
  const root = checkout();
  const commit = (msg: string) =>
    git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", msg);

  const first = entryFor(root);
  record(root, [first]);
  git(root, "add", "-A");
  assert.deepEqual(stagedRemixEdits(root), [], "adding an entry");
  commit("remix");

  record(root, [first, entryFor(root, { remixedAt: "2026-11-01" })]);
  git(root, "add", "-A");
  assert.deepEqual(stagedRemixEdits(root), [], "adding another");

  record(root, [{ ...first, actions: { ...first.actions, delete: "same" } }]);
  git(root, "add", "-A");
  assert.deepEqual(stagedRemixEdits(root), [
    { file: "apps/deals/app.json", entries: ["careers page:/ 2026-10-16"] },
  ]);

  record(root, []);
  git(root, "add", "-A");
  assert.deepEqual(stagedRemixEdits(root), [], "deleting it");
});
