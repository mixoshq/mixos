/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the admin pages render, on the server: the pending list on Apps and
 * Connectors, the review prompt before Register, and the Register result.
 * Browse's side is in ../browse/browse.test.ts.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { filesHash, hashFileTree } from "@/lib/repository/content-hash";
import { pendingLocation, writeSidecar } from "@/lib/repository/pending";
import type { Registered } from "@/lib/repository/pending-outcomes";
import { reviewPendingInstall } from "@/lib/repository/review";
import type { TarEntry } from "@/lib/repository/tar";
import PendingInstallsList, { type PendingItem } from "./pending-installs-list";
import RegisterResult from "./register-result";
import { ReviewPrompt } from "./review-dialog";
import ReviewPanel from "./review-panel";

/** The app router a page has, which the dialogs' refresh needs. Nothing navigates here. */
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
} as unknown as AppRouterInstance;
const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const item = (fields: Partial<PendingItem> = {}): PendingItem => ({
  kind: "app",
  slug: "acme",
  name: "Acme Board",
  path: ".mixos/pending/apps/acme",
  version: "1.2.0",
  installed: "Installed 3 mins ago by admin@example.com",
  problem: null,
  canRegister: true,
  canDiscard: true,
  ...fields,
});

test("the pending list shows each install waiting, with Register and Discard", () => {
  const html = render(createElement(PendingInstallsList, { kind: "app", items: [item()] }));
  const seen = text(html);
  assert.match(seen, /Waiting to register/);
  assert.match(seen, /Installed from the Registry into \.mixos\/pending\/ , where none of their code runs/);
  assert.match(seen, /Acme Board/);
  assert.match(seen, /1\.2\.0/);
  assert.match(seen, /Installed 3 mins ago by admin@example\.com/);
  assert.match(seen, /\.mixos\/pending\/apps\/acme\//);
  assert.match(seen, /Review and register/);
  assert.match(seen, /Discard/);
  // No dialog is open until a button is pressed.
  assert.doesNotMatch(html, /role="dialog"/);
});

test("a pending install with a problem says it, and offers only what still works", () => {
  const stopped = item({
    slug: "stopped",
    name: "Stopped",
    problem: "A registration of it stopped before it finished. Run `npm run register -- --recover`.",
    canRegister: false,
    canDiscard: false,
  });
  const orphan = item({
    slug: "orphan",
    name: "Orphan",
    installed: null,
    problem: "It has no record of what install verified (.mixos/pending/apps/orphan.json), so it can't be registered. Discard it.",
    canRegister: false,
  });
  const seen = text(render(createElement(PendingInstallsList, { kind: "app", items: [stopped, orphan] })));
  assert.match(seen, /Needs attention/);
  assert.match(seen, /npm run register -- --recover/);
  assert.match(seen, /Discard it\./);
  assert.doesNotMatch(seen, /Review and register/);
  // Discard for the orphan, none for the stopped registration.
  assert.equal(seen.match(/\bDiscard\b(?! it)/g)?.length, 1);
});

test("nothing pending renders nothing", () => {
  assert.equal(render(createElement(PendingInstallsList, { kind: "connector", items: [] })), "");
});

// ── the review prompt ───────────────────────────────────────────────────────

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-pending-render-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function pendingReview() {
  const entries: TarEntry[] = [
    ["app.json", JSON.stringify({ name: "Acme Board", egress: ["api.acme.example"], env: [{ key: "ACME_TOKEN", label: "Token", type: "password" }], mcp: [{ name: "list-boards", description: "x" }] })],
    ["hooks.ts", "export {};\n"],
    ["api/boards/route.ts", "export {};\n"],
    ["widgets.ts", "export default {};\n"],
    ["jobs/nightly.ts", "export default async function run() {}\n"],
    ["migrations/0001_boards.sql", "create table boards (id integer primary key);\n"],
  ].map(([p, d]) => ({ path: p, mode: 0o644, data: Buffer.from(d) }));
  const where = pendingLocation(tmp, "app", "acme");
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(where.folder, e.path)), { recursive: true });
    fs.writeFileSync(path.join(where.folder, e.path), e.data);
  }
  writeSidecar(where.sidecar, {
    kind: "app",
    slug: "acme",
    source: "https://mixos.org",
    version: "1.2.0",
    gitTag: "v1.2.0",
    commitSha: "c".repeat(40),
    contentHash: hashFileTree(entries),
    filesHash: filesHash(entries),
    requiresMixOS: "0.0.1",
    yankedAccepted: false,
    installedAt: "2026-10-11T09:00:00.000Z",
    installedBy: "admin@example.com",
    fileCount: entries.length,
    byteCount: 400,
    check: { verdict: "accepted", deferred: ["apps/acme/widgets.ts: the widget config fields it builds are checked at registration, which loads it."] },
  });
  return reviewPendingInstall(tmp, "app", "acme");
}

test("the review prompt repeats what will run, what was deferred, the claims beside the manifest, the floor and the source", () => {
  const review = pendingReview();
  const sourceUrl = `https://github.com/acme/mixos-apps/tree/${"c".repeat(40)}/apps/acme`;
  const html = render(
    createElement(ReviewPanel, {
      review,
      listing: {
        state: "ok",
        origin: "https://mixos.org",
        claims: [{ scope: "network:api.acme.example", reason: "Reads your boards." }],
        sourceUrl,
        note: null,
      },
    }),
  );
  const seen = text(html);
  // What will run.
  for (const label of ["hooks.ts", "api/", "widgets.ts", "jobs/", "migrations/*.sql"]) {
    assert.ok(seen.includes(label), label);
  }
  assert.match(seen, /api\/boards\/route\.ts/);
  assert.match(seen, /jobs\/nightly\.ts/);
  assert.match(seen, /migrations\/0001_boards\.sql/);
  assert.match(seen, /loads its code for the first time/);
  assert.match(seen, /the server's full environment/);
  // What install's check left to registration.
  assert.match(seen, /Checked when it is registered/);
  assert.match(seen, /widget config fields it builds are checked at registration/);
  // The manifest beside the publisher's words.
  assert.match(seen, /The package's manifest What this instance enforces\./);
  assert.match(seen, /Egress api\.acme\.example/);
  assert.match(seen, /Env ACME_TOKEN \(secret\)/);
  assert.match(seen, /MCP tools list-boards/);
  assert.match(seen, /Database None/);
  assert.match(seen, /Its publisher Their words on mixos\.org, not a guarantee\./);
  assert.match(seen, /network:api\.acme\.example Reads your boards\./);
  // The floor.
  assert.match(seen, /It requires MixOS 0\.0\.1 or newer\. This checkout is .+, which meets it\./);
  // The source, at the installed commit.
  assert.ok(html.includes(`href="${sourceUrl}"`));
  assert.match(seen, /Read it on GitHub at the commit that was verified/);
});

test("the prompt asks the admin to confirm they read it, unless Register would refuse it", () => {
  const review = pendingReview();
  const listing = { state: "unavailable" as const, origin: "https://mixos.org", message: "Not asked." };
  const html = render(createElement(ReviewPrompt, { review, listing, read: false, onRead: () => {} }));
  assert.match(html, /<input type="checkbox"[^>]*>/);
  assert.doesNotMatch(html.match(/<input type="checkbox"[^>]*>/)![0], /checked/);
  assert.match(text(html), /I've read what will run, and I want to run it in this checkout\./);
  assert.match(text(html), /npm run register -- app\/acme/);

  const refused = render(
    createElement(ReviewPrompt, {
      review: { ...review, problem: "Its files have changed since it was installed, so Register would refuse it." },
      listing,
      read: false,
      onRead: () => {},
    }),
  );
  assert.doesNotMatch(refused, /type="checkbox"/);
  assert.match(text(refused), /It can't be registered as it is Its files have changed since it was installed/);
});

test("without the catalogue, the review still stands and says why", () => {
  const seen = text(
    render(
      createElement(ReviewPanel, {
        review: pendingReview(),
        listing: { state: "unavailable", origin: "https://mixos.org", message: "https://mixos.org couldn't be asked (timeout)." },
      }),
    ),
  );
  assert.match(seen, /couldn't be asked \(timeout\)/);
  assert.match(seen, /Read it in \.mixos\/pending\/apps\/acme\/ in this checkout\./);
  assert.match(seen, /api\/boards\/route\.ts/);
});

// ── the Register result ─────────────────────────────────────────────────────

const registered = (fields: Partial<Registered> = {}): Registered => ({
  kind: "app",
  slug: "acme",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: "c".repeat(40),
  installPath: "apps/acme",
  fileCount: 6,
  byteCount: 4000,
  deferredChecked: 1,
  migrations: 1,
  servesNow: true,
  database: { hosts: ["127.0.0.1"], local: true },
  activation: "here",
  ...fields,
});

test("on a local database the result offers Activate in this checkout, and says how to ship", () => {
  const seen = text(render(createElement(RegisterResult, { result: registered(), name: "Acme Board" })));
  assert.match(seen, /Registered to apps\/acme/);
  assert.match(seen, /The dev server runs it now\./);
  assert.match(seen, /Database 127\.0\.0\.1 · on this machine/);
  assert.match(seen, /Activate in this checkout/);
  assert.match(seen, /run npm run migrate:apps in this checkout first/);
  assert.doesNotMatch(seen, /`/);
  assert.match(seen, /Commit apps\/acme to your repository\. Until then it runs only in this checkout\./);
  assert.match(seen, /It arrives inactive on each instance: activate it there, in Admin > Apps\./);
});

test("on a shared database it points to the instance that serves the app, with no button", () => {
  const seen = text(
    render(
      createElement(RegisterResult, {
        result: registered({ database: { hosts: ["db.example.com"], local: false }, activation: "elsewhere" }),
        name: "Acme Board",
      }),
    ),
  );
  assert.match(seen, /Database db\.example\.com · other instances may use it/);
  assert.match(seen, /Activate it in Admin > Apps on the instance that serves it\./);
  assert.doesNotMatch(seen, /Activate in this checkout/);
});

test("a production build of the checkout says to rebuild first; a connector has nothing to turn on", () => {
  const rebuild = text(
    render(createElement(RegisterResult, { result: registered({ servesNow: false, activation: "after-rebuild" }), name: "Acme Board" })),
  );
  assert.match(rebuild, /runs the new code after npm run build and a restart/);
  assert.doesNotMatch(rebuild, /Activate in this checkout/);
  const connector = text(
    render(
      createElement(RegisterResult, {
        result: registered({ kind: "connector", installPath: "connectors/acme-crm", migrations: 0, activation: "none" }),
        name: "Acme CRM",
      }),
    ),
  );
  assert.match(connector, /Configure it in Admin > Connectors\./);
  assert.doesNotMatch(connector, /Turn it on/);
});
