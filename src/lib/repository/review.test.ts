/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The review an admin reads before Register: built from a pending install's
 * folder and sidecar alone, in a checkout of its own.
 */

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mixosVersion } from "../platform/version";
import { filesHash, hashFileTree } from "./content-hash";
import { pendingLocation, writeSidecar, type PendingKind, type PendingSidecar } from "./pending";
import {
  ReviewError,
  declaredBy,
  githubSourceUrl,
  migrationCount,
  pendingDisplayName,
  reviewPendingInstall,
  runGroups,
  shownText,
} from "./review";
import type { TarEntry } from "./tar";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-review-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
let root: string;
beforeEach(() => {
  root = path.join(tmp, `checkout-${n++}`);
  fs.mkdirSync(root, { recursive: true });
});

const file = (p: string, data: string): TarEntry => ({ path: p, mode: 0o644, data: Buffer.from(data) });

const APP_JSON = {
  name: "Acme Board",
  database: true,
  egress: ["api.acme.example"],
  env: [
    { key: "ACME_REGION", label: "Region", type: "text" },
    { key: "ACME_TOKEN", label: "Token", type: "password" },
  ],
  connectors: ["gmail"],
  optionalConnectors: ["slack"],
  provides: [{ name: "boards", consumers: "*" }],
  consumes: [{ app: "files", service: "upload" }],
  emits: [{ name: "board.created", consumers: "*" }],
  listensTo: [{ app: "crm", hook: "deal.won" }],
  branding: { hooks: ["brand-name"], reason: "Its own name" },
  mcp: [{ name: "list-boards", description: "Lists boards" }],
};

const ACME = [
  file("app.json", JSON.stringify(APP_JSON)),
  file("hooks.ts", "export {};\n"),
  file("api/boards/route.ts", "export {};\n"),
  file("api/boards/[id]/route.ts", "export {};\n"),
  file("widgets.ts", "export default {};\n"),
  file("jobs/nightly.ts", "export default async function run() {}\n"),
  file("migrations/0001_boards.sql", "create table boards (id integer primary key);\n"),
  file("migrations/README.md", "Not SQL.\n"),
  file("pages/Main.tsx", "export default function Main() { return null; }\n"),
  file("mcp/list-boards.ts", "export {};\n"),
  file("README.md", "# Acme\n"),
];

/** A pending install, as install leaves one. */
function pend(kind: PendingKind, slug: string, entries: TarEntry[] = ACME, fields: Partial<PendingSidecar> = {}) {
  const where = pendingLocation(root, kind, slug);
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(where.folder, e.path)), { recursive: true });
    fs.writeFileSync(path.join(where.folder, e.path), e.data, { mode: 0o644 });
  }
  writeSidecar(where.sidecar, {
    kind,
    slug,
    source: "https://mixos.org",
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "c".repeat(40),
    contentHash: hashFileTree(entries),
    filesHash: filesHash(entries),
    requiresMixOS: null,
    yankedAccepted: false,
    installedAt: "2026-10-11T09:00:00.000Z",
    installedBy: "admin@example.com",
    fileCount: entries.length,
    byteCount: entries.reduce((s, e) => s + e.data.length, 0),
    check: { verdict: "accepted", deferred: ["apps/acme/widgets.ts: the widget config fields it builds are checked at registration, which loads it."] },
    ...fields,
  });
  return where;
}

test("an app's review lists what will run, by when it runs", () => {
  pend("app", "acme");
  const review = reviewPendingInstall(root, "app", "acme");
  assert.equal(review.name, "Acme Board");
  assert.equal(review.folder, ".mixos/pending/apps/acme");
  assert.equal(review.target, "apps/acme");
  assert.equal(review.problem, null);
  const byLabel = Object.fromEntries(review.runs.map((g) => [g.label, g.files]));
  assert.deepEqual(byLabel["hooks.ts"], ["hooks.ts"]);
  assert.deepEqual(byLabel["api/"], ["api/boards/[id]/route.ts", "api/boards/route.ts"]);
  assert.deepEqual(byLabel["widgets.ts"], ["widgets.ts"]);
  assert.deepEqual(byLabel["jobs/"], ["jobs/nightly.ts"]);
  assert.deepEqual(byLabel["migrations/*.sql"], ["migrations/0001_boards.sql"]);
  assert.deepEqual(byLabel["Other code"], ["mcp/list-boards.ts", "pages/Main.tsx"]);
  // The check's verdict, from the sidecar.
  assert.equal(review.deferred.length, 1);
  assert.match(review.deferred[0], /widgets\.ts/);
  // What install verified.
  assert.equal(review.release.version, "1.2.0");
  assert.equal(review.release.commitSha, "c".repeat(40));
  assert.equal(review.release.installedBy, "admin@example.com");
});

test("an app's manifest declarations, in the review's terms", () => {
  const declared = Object.fromEntries(declaredBy("app", APP_JSON).map((d) => [d.label, d.values]));
  assert.deepEqual(declared, {
    Egress: ["api.acme.example"],
    Env: ["ACME_REGION", "ACME_TOKEN (secret)"],
    Database: ["Its own schema and database role"],
    Connectors: ["gmail", "slack (optional)"],
    Services: ["provides boards", "uses files/upload"],
    Hooks: ["emits board.created", "listens to crm.deal.won", "brand hook brand-name"],
    "MCP tools": ["list-boards"],
  });
  // An app that declares nothing shows every category, empty.
  for (const d of declaredBy("app", { name: "Bare" })) assert.deepEqual(d.values, [], d.label);
});

test("a connector's review: its code, and what its manifest says it reaches", () => {
  const manifest = {
    name: "acme-crm",
    displayName: "Acme CRM",
    auth: {
      strategy: "oauth2_authorization_code",
      tokenUrl: "https://auth.acme.example/token",
      authorizeUrl: "https://auth.acme.example/authorize",
    },
    http: { baseUrl: "https://api.acme.example/v2" },
    credentialFields: [
      { key: "clientId", label: "Client ID", type: "text" },
      { key: "clientSecret", label: "Client secret", type: "password" },
    ],
    userScoped: true,
    webhook: { algorithm: "hmac-sha256", signatureHeader: "x-sig", secretKey: "clientSecret" },
  };
  pend("connector", "acme-crm", [
    file("connector.json", JSON.stringify(manifest)),
    file("index.ts", "export {};\n"),
    file("lib/client.ts", "export {};\n"),
    file("assets/icon.svg", "<svg/>"),
  ]);
  const review = reviewPendingInstall(root, "connector", "acme-crm");
  assert.equal(review.name, "Acme CRM");
  assert.deepEqual(review.runs.map((g) => [g.label, g.files]), [["Code", ["index.ts", "lib/client.ts"]]]);
  assert.deepEqual(
    Object.fromEntries((review.declared ?? []).map((d) => [d.label, d.values])),
    {
      "Hosts it reaches": ["api.acme.example", "auth.acme.example"],
      "Credentials an admin enters": ["clientId", "clientSecret"],
      "Each person's own account": ["Yes: each person signs in with their own"],
      Webhooks: ["Receives signed webhooks"],
    },
  );
});

test("the release's floor, met and not", () => {
  pend("app", "met", ACME, { requiresMixOS: "0.0.1" });
  const met = reviewPendingInstall(root, "app", "met").requiresMixOS;
  assert.deepEqual(met, { declared: "0.0.1", current: mixosVersion(), met: true, checked: true, reason: null });

  pend("app", "unmet", ACME, { requiresMixOS: "999.0.0" });
  const unmet = reviewPendingInstall(root, "app", "unmet");
  assert.equal(unmet.requiresMixOS.met, false);
  // Register would refuse it, so the review says so before anyone asks.
  assert.match(unmet.problem ?? "", /requires 999\.0\.0 or newer/);

  pend("app", "odd", ACME, { requiresMixOS: "soon" });
  const odd = reviewPendingInstall(root, "app", "odd").requiresMixOS;
  assert.equal(odd.met, true);
  assert.equal(odd.checked, false);
  assert.match(odd.reason ?? "", /not a version/);
});

test("a folder changed after install is flagged, as Register would refuse it", () => {
  const where = pend("app", "acme");
  fs.appendFileSync(path.join(where.folder, "api/boards/route.ts"), "// edited\n");
  assert.match(reviewPendingInstall(root, "app", "acme").problem ?? "", /changed since it was installed/);
});

test("a registration that stopped midway is flagged for recovery", () => {
  pend("app", "acme", ACME, {
    register: { token: "t".repeat(32), pid: 4242, hostname: "elsewhere", startedAt: "2026-10-11T09:05:00.000Z" },
  });
  assert.match(reviewPendingInstall(root, "app", "acme").problem ?? "", /--recover/);
});

test("nothing pending, or a folder with no record, has no review", () => {
  assert.throws(() => reviewPendingInstall(root, "app", "ghost"), (err: unknown) => err instanceof ReviewError && /Nothing named ghost/.test((err as Error).message));
  const where = pend("app", "acme");
  fs.rmSync(where.sidecar);
  assert.throws(() => reviewPendingInstall(root, "app", "acme"), (err: unknown) => err instanceof ReviewError && /Discard it/.test((err as Error).message));
});

test("an unreadable manifest leaves the declarations out, not the review", () => {
  pend("app", "acme", [file("app.json", "{ not json"), file("api/x/route.ts", "export {};\n")]);
  const review = reviewPendingInstall(root, "app", "acme");
  assert.equal(review.declared, null);
  assert.equal(review.name, "acme");
});

test("the package's text is shown on one line, without control or bidi characters", () => {
  assert.equal(shownText("Acme‮ evil\nname\u0007"), "Acme evil name");
  assert.equal(shownText("x".repeat(500)).length, 120);
  assert.equal(pendingDisplayName(root, "app", "missing"), "missing");
});

test("long lists are cut, and say how many more", () => {
  const files = Array.from({ length: 45 }, (_, i) => `api/r${String(i).padStart(2, "0")}/route.ts`);
  const api = runGroups("app", files).find((g) => g.label === "api/")!;
  assert.equal(api.files.length, 40);
  assert.equal(api.more, 5);
});

test("migrations are counted from the registered folder", () => {
  const dir = path.join(root, "apps", "acme");
  fs.mkdirSync(path.join(dir, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(dir, "migrations", "0001_a.sql"), "");
  fs.writeFileSync(path.join(dir, "migrations", "0002_b.sql"), "");
  fs.writeFileSync(path.join(dir, "migrations", "notes.md"), "");
  assert.equal(migrationCount(dir), 2);
  assert.equal(migrationCount(path.join(root, "apps", "none")), 0);
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
});
