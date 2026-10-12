/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The admin pages' review, Register, Discard and "Activate in this checkout":
 * the work behind the server actions in ./pending-actions.ts, given an admin
 * and a deployment of the test's choosing.
 *
 * Register and Discard are the real ones (./register.ts), each in a checkout of
 * its own, with a stand-in for the registry generator and a stubbed database
 * pool that answers the register lock and keeps the audit rows, as
 * ./register.test.ts runs them.
 */

import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AdminActor } from "../apps/admin-audit";
import type { DatabaseLocation } from "../db/locality";
import { BUILT_DEPLOYMENT_NOTICE } from "../platform/build";
import { tryAcquireCheckoutLock } from "../platform/checkout-lock";
import { filesHash, hashFileTree } from "./content-hash";
import { INSTALL_RECORD_FILE, serializeInstallRecord } from "./install-record";
import { pendingLocation, writeSidecar, type PendingKind } from "./pending";
import {
  LOCKED_MESSAGE,
  activateFromButton,
  activationFor,
  discardFromButton,
  listingFacts,
  registerFromButton,
  reviewForButton,
  type ActivateContext,
  type RegisterContext,
  type ReviewContext,
} from "./pending-admin";
import type { ListingFacts } from "./pending-outcomes";
import { reviewPendingInstall } from "./review";
import type { TarEntry } from "./tar";

// ── the database ────────────────────────────────────────────────────────────

interface AuditRow {
  actor_id: unknown;
  actor_email: unknown;
  action: string;
  target_id: unknown;
  details: Record<string, unknown>;
}

let audit: AuditRow[] = [];
let lockStatements = 0;
/** Set to make the register lock read as held by someone else. */
let rowLockTaken = false;

const pool = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("insert into public._platform_locks")) {
      lockStatements++;
      return rowLockTaken ? [] : [{ holder: values[1] }];
    }
    if (text.startsWith("update public._platform_locks")) {
      lockStatements++;
      return [{ held: 1 }];
    }
    if (text.startsWith("delete from public._platform_locks")) {
      lockStatements++;
      return [];
    }
    if (text.startsWith("insert into public.admin_audit_log")) {
      audit.push({
        actor_id: values[0],
        actor_email: values[1],
        action: values[2] as string,
        target_id: values[4],
        details: (values[5] as { json: Record<string, unknown> }).json,
      });
      return [];
    }
    throw new Error(`unexpected statement: ${text}`);
  },
  { json: (value: unknown) => ({ json: value }) },
);
(globalThis as { __pg?: unknown }).__pg = pool;

// ── checkouts ───────────────────────────────────────────────────────────────

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-pending-admin-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The stand-in generator: "registers" every folder in apps/ and connectors/. */
const STAND_IN = path.join(tmp, "stand-in.mjs");
fs.writeFileSync(
  STAND_IN,
  `import fs from "node:fs";
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : []);
fs.mkdirSync("src/generated", { recursive: true });
fs.writeFileSync("src/generated/app-registry.ts", "export const appRegistry = " + JSON.stringify(list("apps").map((slug) => ({ slug })), null, 2) + ";\\n");
fs.writeFileSync("src/generated/connector-registry.ts", "export const connectorRegistry = " + JSON.stringify(list("connectors").map((name) => ({ name })), null, 2) + ";\\n");
`,
);

let n = 0;
let root: string;
let revalidated: string[] = [];

beforeEach(() => {
  root = path.join(tmp, `checkout-${n++}`);
  for (const dir of ["apps", "connectors", "themes"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  audit = [];
  lockStatements = 0;
  rowLockTaken = false;
  revalidated = [];
});

const ADMIN: AdminActor = { id: "11111111-2222-3333-4444-555555555555", email: "admin@example.com" };
const LOCAL: DatabaseLocation = { hosts: ["127.0.0.1"], local: true };
const SHARED: DatabaseLocation = { hosts: ["db.example.com"], local: false };

const file = (p: string, data: string): TarEntry => ({ path: p, mode: 0o644, data: Buffer.from(data) });
const ACME = [
  file("app.json", '{"name":"Acme"}\n'),
  file("api/items/route.ts", "export {};\n"),
  file("migrations/0001_items.sql", "create table items (id integer primary key);\n"),
];

/**
 * A pending install, as install leaves one: the tree with its record, from
 * `source`, and the sidecar beside it. Returns the files hash a review shows.
 */
function pend(kind: PendingKind, slug: string, entries: TarEntry[] = ACME, source = "https://mixos.org"): string {
  const where = pendingLocation(root, kind, slug);
  fs.mkdirSync(where.folder, { recursive: true });
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(where.folder, e.path)), { recursive: true });
    fs.writeFileSync(path.join(where.folder, e.path), e.data, { mode: 0o644 });
  }
  fs.writeFileSync(
    path.join(where.folder, INSTALL_RECORD_FILE),
    serializeInstallRecord({
      source,
      kind,
      slug,
      version: "1.2.0",
      gitTag: "v1.2.0",
      commitSha: "c".repeat(40),
      contentHash: hashFileTree(entries),
      filesHash: filesHash(entries),
      repository: { owner: "acme", name: "mixos-apps", subpath: `apps/${slug}` },
      requiresMixOS: null,
    }),
  );
  writeSidecar(where.sidecar, {
    kind,
    slug,
    yankedAccepted: false,
    installedAt: "2026-10-11T09:00:00.000Z",
    installedBy: "admin@example.com",
    check: { verdict: "accepted", deferred: ["apps/acme/api/items/route.ts: checked at registration."] },
  });
  return filesHash(entries);
}

const exists = (rel: string) => fs.existsSync(path.join(root, rel));

function registerContext(extra: Partial<RegisterContext> = {}): RegisterContext {
  return {
    admin: async () => ADMIN,
    builtDeployment: () => false,
    revalidate: (p) => revalidated.push(p),
    root,
    generator: STAND_IN,
    database: () => LOCAL,
    servesWithoutRebuild: () => true,
    ...extra,
  };
}

const NOT_ADMIN = async (): Promise<AdminActor> => {
  throw new Error("Admin access required");
};

// ── admin first ─────────────────────────────────────────────────────────────

describe("every action requires an admin before anything else", () => {
  test("Register, Discard and the review are refused, and nothing is touched", async () => {
    const reviewed = pend("app", "acme");
    let listed = 0;
    await assert.rejects(
      registerFromButton({ kind: "app", slug: "acme", reviewedFilesHash: reviewed }, registerContext({ admin: NOT_ADMIN })),
      /Admin access required/,
    );
    await assert.rejects(discardFromButton({ kind: "app", slug: "acme" }, registerContext({ admin: NOT_ADMIN })), /Admin access required/);
    await assert.rejects(
      reviewForButton(
        { kind: "app", slug: "acme" },
        { ...registerContext({ admin: NOT_ADMIN }), listing: async () => (listed++, { state: "unavailable", origin: "", message: "" }) },
      ),
      /Admin access required/,
    );
    let activated = 0;
    await assert.rejects(
      activateFromButton(
        { slug: "acme" },
        { admin: NOT_ADMIN, builtDeployment: () => false, database: () => LOCAL, inThisBuild: () => true, activate: async () => void activated++ },
      ),
      /Admin access required/,
    );
    assert.equal(listed, 0);
    assert.equal(activated, 0);
    assert.equal(lockStatements, 0);
    assert.deepEqual(audit, []);
    assert.ok(exists(".mixos/pending/apps/acme"));
    assert.ok(!exists("apps/acme"));
  });

  test("the admin is asked before the input is read", async () => {
    let asked = 0;
    const outcome = await registerFromButton(
      { kind: "theme", slug: "../etc", reviewedFilesHash: "nope" },
      registerContext({ admin: async () => (asked++, ADMIN) }),
    );
    assert.equal(asked, 1);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.code, "not-pending");
    assert.equal(lockStatements, 0);
  });
});

// ── a built deployment ──────────────────────────────────────────────────────

describe("a built deployment refuses, as information", () => {
  test("Register is refused before the locks, and the refusal is audited as the button's", async () => {
    const reviewed = pend("app", "acme");
    const outcome = await registerFromButton(
      { kind: "app", slug: "acme", reviewedFilesHash: reviewed },
      registerContext({ builtDeployment: () => true }),
    );
    assert.deepEqual(outcome, {
      ok: false,
      code: "unsupported-environment",
      message: BUILT_DEPLOYMENT_NOTICE,
      tone: "info",
    });
    assert.equal(
      BUILT_DEPLOYMENT_NOTICE,
      "This deployment runs a build. Install and register in a checkout of your repository, commit, and deploy.",
    );
    assert.equal(lockStatements, 0);
    assert.ok(exists(".mixos/pending/apps/acme"));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "app.register.rejected");
    assert.equal(audit[0].actor_email, ADMIN.email);
    assert.deepEqual(audit[0].details, { via: "button", reason: "unsupported-environment", message: BUILT_DEPLOYMENT_NOTICE });
  });

  test("Discard and the review are refused the same way", async () => {
    pend("app", "acme");
    const discarded = await discardFromButton({ kind: "app", slug: "acme" }, registerContext({ builtDeployment: () => true }));
    assert.equal(!discarded.ok && discarded.tone, "info");
    assert.equal(!discarded.ok && discarded.message, BUILT_DEPLOYMENT_NOTICE);
    const reviewed = await reviewForButton(
      { kind: "app", slug: "acme" },
      { ...registerContext({ builtDeployment: () => true }), listing: async () => ({ state: "unavailable", origin: "", message: "" }) },
    );
    assert.equal(!reviewed.ok && reviewed.code, "unsupported-environment");
    assert.equal(lockStatements, 0);
    assert.ok(exists(".mixos/pending/apps/acme"));
  });
});

// ── Register ────────────────────────────────────────────────────────────────

describe("Register", () => {
  test("calls through to Register under both locks, and audits the admin with via: button", async () => {
    const reviewed = pend("app", "acme");
    const outcome = await registerFromButton({ kind: "app", slug: "acme", reviewedFilesHash: reviewed }, registerContext());
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.result.installPath, "apps/acme");
    assert.equal(outcome.result.version, "1.2.0");
    assert.equal(outcome.result.deferredChecked, 1);
    assert.equal(outcome.result.migrations, 1);
    assert.equal(outcome.result.activation, "here");
    assert.deepEqual(outcome.result.database, LOCAL);
    // Nothing the browser doesn't need: no generator output, no paths on this machine.
    assert.ok(!JSON.stringify(outcome).includes(tmp));

    assert.ok(exists("apps/acme/api/items/route.ts"));
    assert.ok(!exists(".mixos/pending/apps/acme"));
    assert.ok(!exists(".mixos/pending/apps/acme.json"));
    assert.ok(!exists(".mixos/lock"));
    assert.ok(lockStatements > 0);
    assert.deepEqual(revalidated, ["/admin/apps"]);

    assert.equal(audit.length, 1);
    const [row] = audit;
    assert.equal(row.action, "app.register");
    assert.equal(row.target_id, "acme");
    assert.equal(row.actor_id, ADMIN.id);
    assert.equal(row.actor_email, ADMIN.email);
    assert.equal(row.details.via, "button");
    assert.equal(row.details.filesHash, reviewed);

    // What to commit, and how, from the record now in apps/acme/.
    const { handBack } = outcome.result;
    assert.equal(handBack.folder, "apps/acme");
    assert.ok(handBack.files.some((f) => f.path === INSTALL_RECORD_FILE));
    assert.equal(handBack.commitMessage.split("\n")[0], "feat(acme): add app acme 1.2.0 from mixos.org");
    assert.equal(handBack.sourceUrl, `https://github.com/acme/mixos-apps/tree/${"c".repeat(40)}/apps/acme`);
  });

  test("a connector registers too, with nothing to activate", async () => {
    const reviewed = pend("connector", "acme-crm", [file("connector.json", '{"name":"acme-crm"}\n'), file("index.ts", "export {};\n")]);
    const outcome = await registerFromButton(
      { kind: "connector", slug: "acme-crm", reviewedFilesHash: reviewed },
      registerContext(),
    );
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.result.activation, "none");
    assert.ok(exists("connectors/acme-crm/index.ts"));
    assert.deepEqual(revalidated, ["/admin/connectors"]);
    assert.equal(audit[0].action, "connector.register");
    assert.equal(audit[0].details.via, "button");
  });

  test("refuses what the admin didn't review: it was replaced since", async () => {
    pend("app", "acme");
    const other = filesHash([file("app.json", '{"name":"Something else"}\n')]);
    const outcome = await registerFromButton({ kind: "app", slug: "acme", reviewedFilesHash: other }, registerContext());
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.code, "changed-meanwhile");
    assert.match(!outcome.ok ? outcome.message : "", /isn't what you reviewed/);
    assert.ok(exists(".mixos/pending/apps/acme"));
    assert.ok(!exists("apps/acme"));
    assert.equal(audit[0].action, "app.register.rejected");
    assert.equal(audit[0].details.via, "button");
    assert.equal(audit[0].details.reason, "changed-meanwhile");
  });

  test("another administrator holding the register lock reads as that, with Try again", async () => {
    const reviewed = pend("app", "acme");
    rowLockTaken = true;
    const outcome = await registerFromButton({ kind: "app", slug: "acme", reviewedFilesHash: reviewed }, registerContext());
    assert.deepEqual(outcome, { ok: false, code: "locked", message: LOCKED_MESSAGE, tone: "neutral" });
    assert.equal(
      LOCKED_MESSAGE,
      "Another administrator is installing, registering or removing an extension. Try again in a moment.",
    );
    assert.ok(exists(".mixos/pending/apps/acme"));
    assert.equal(audit[0].action, "app.register.rejected");
    assert.equal(audit[0].details.reason, "locked");
    assert.equal(audit[0].details.via, "button");

    // Try again, once it is free.
    rowLockTaken = false;
    const again = await registerFromButton({ kind: "app", slug: "acme", reviewedFilesHash: reviewed }, registerContext());
    assert.ok(again.ok, JSON.stringify(again));
  });

  test("the checkout lock held by the generator names its holder", async () => {
    const reviewed = pend("app", "acme");
    const held = tryAcquireCheckoutLock(root, "the registry generator (npm run dev)");
    try {
      const outcome = await registerFromButton({ kind: "app", slug: "acme", reviewedFilesHash: reviewed }, registerContext());
      assert.equal(outcome.ok, false);
      assert.equal(!outcome.ok && outcome.code, "locked");
      assert.equal(!outcome.ok && outcome.tone, "neutral");
      assert.match(!outcome.ok ? outcome.message : "", /locked by the registry generator \(npm run dev\)/);
    } finally {
      held.release();
    }
    assert.ok(exists(".mixos/pending/apps/acme"));
  });

  test("where the app is turned on follows the database and the server", async () => {
    assert.equal(activationFor("app", LOCAL, true), "here");
    assert.equal(activationFor("app", LOCAL, false), "after-rebuild");
    assert.equal(activationFor("app", SHARED, true), "elsewhere");
    assert.equal(activationFor("app", SHARED, false), "elsewhere");
    assert.equal(activationFor("app", { hosts: [], local: false }, true), "elsewhere");
    assert.equal(activationFor("connector", LOCAL, true), "none");

    const reviewed = pend("app", "acme");
    const outcome = await registerFromButton(
      { kind: "app", slug: "acme", reviewedFilesHash: reviewed },
      registerContext({ database: () => SHARED }),
    );
    assert.ok(outcome.ok);
    assert.equal(outcome.result.activation, "elsewhere");
    assert.deepEqual(outcome.result.database, SHARED);
  });
});

// ── Discard ─────────────────────────────────────────────────────────────────

describe("Discard", () => {
  test("calls through to Discard, and audits the admin with via: button", async () => {
    pend("app", "acme");
    const outcome = await discardFromButton({ kind: "app", slug: "acme" }, registerContext());
    assert.deepEqual(outcome, { ok: true, pendingPath: ".mixos/pending/apps/acme" });
    assert.ok(!exists(".mixos/pending/apps/acme"));
    assert.ok(!exists(".mixos/pending/apps/acme.json"));
    assert.deepEqual(revalidated, ["/admin/apps"]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "app.discard");
    assert.equal(audit[0].actor_id, ADMIN.id);
    assert.equal(audit[0].details.via, "button");
  });

  test("a held lock leaves it in place, and says so", async () => {
    pend("app", "acme");
    rowLockTaken = true;
    const outcome = await discardFromButton({ kind: "app", slug: "acme" }, registerContext());
    assert.deepEqual(outcome, { ok: false, code: "locked", message: LOCKED_MESSAGE, tone: "neutral" });
    assert.ok(exists(".mixos/pending/apps/acme"));
  });

  test("nothing to discard is said plainly", async () => {
    const outcome = await discardFromButton({ kind: "app", slug: "ghost" }, registerContext());
    assert.equal(!outcome.ok && outcome.code, "not-pending");
    assert.equal(!outcome.ok && outcome.tone, "warning");
  });
});

// ── Activate in this checkout ───────────────────────────────────────────────

describe("Activate in this checkout", () => {
  function context(extra: Partial<ActivateContext> = {}): ActivateContext & { activated: string[] } {
    const activated: string[] = [];
    return {
      admin: async () => ADMIN,
      builtDeployment: () => false,
      database: () => LOCAL,
      inThisBuild: () => true,
      activate: async (slug) => void activated.push(slug),
      ...extra,
      activated,
    };
  }

  test("turns it on when this checkout's database is local", async () => {
    const ctx = context();
    assert.deepEqual(await activateFromButton({ slug: "acme" }, ctx), { ok: true, slug: "acme" });
    assert.deepEqual(ctx.activated, ["acme"]);
  });

  test("refuses a database other instances may share, naming its host", async () => {
    const ctx = context({ database: () => SHARED });
    const outcome = await activateFromButton({ slug: "acme" }, ctx);
    assert.equal(!outcome.ok && outcome.code, "shared-database");
    assert.match(!outcome.ok ? outcome.message : "", /db\.example\.com.*Admin > Apps on the instance that serves it/);
    assert.deepEqual(ctx.activated, []);
  });

  test("refuses on a built deployment, and before this server runs the app", async () => {
    const built = context({ builtDeployment: () => true });
    assert.equal((await activateFromButton({ slug: "acme" }, built)).ok, false);
    const stale = context({ inThisBuild: () => false });
    const outcome = await activateFromButton({ slug: "acme" }, stale);
    assert.equal(!outcome.ok && outcome.code, "not-in-this-build");
    assert.deepEqual([...built.activated, ...stale.activated], []);
  });

  test("activation's own refusal is shown; anything else isn't", async () => {
    const connector = await activateFromButton(
      { slug: "acme" },
      context({ activate: async () => { throw new Error("Configure Gmail before activating this app."); } }),
    );
    assert.equal(!connector.ok && connector.message, "Configure Gmail before activating this app.");
    const original = console.error;
    console.error = () => {};
    try {
      const other = await activateFromButton(
        { slug: "acme" },
        context({ activate: async () => { throw new Error("relation \"apps\" does not exist at 10.0.0.5"); } }),
      );
      assert.equal(!other.ok && other.code, "refused");
      assert.ok(!other.ok && !other.message.includes("10.0.0.5"));
    } finally {
      console.error = original;
    }
  });
});

// ── the review ──────────────────────────────────────────────────────────────

describe("the review", () => {
  test("is the pending install's own, with what the catalogue says beside it", async () => {
    pend("app", "acme");
    const facts: ListingFacts = { state: "ok", origin: "https://mixos.org", claims: [], note: null };
    const ctx: ReviewContext = { ...registerContext(), listing: async () => facts };
    const outcome = await reviewForButton({ kind: "app", slug: "acme" }, ctx);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.review.slug, "acme");
    assert.equal(outcome.review.release.filesHash, filesHash(ACME));
    assert.equal(outcome.review.sourceUrl, `https://github.com/acme/mixos-apps/tree/${"c".repeat(40)}/apps/acme`);
    assert.equal(outcome.listing, facts);
    // Reading changes nothing, and takes no lock.
    assert.equal(lockStatements, 0);
    assert.deepEqual(audit, []);
  });

  test("of nothing pending is a refusal, not an error", async () => {
    const outcome = await reviewForButton(
      { kind: "app", slug: "ghost" },
      { ...registerContext(), listing: async () => ({ state: "unavailable", origin: "", message: "" }) },
    );
    assert.equal(!outcome.ok && outcome.code, "not-pending");
  });
});

// ── what the catalogue says ─────────────────────────────────────────────────

describe("the publisher's claims", () => {
  const sha = "c".repeat(40);
  let installCommit = sha;
  let answering = true;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!answering) {
      res.writeHead(503).end();
      return;
    }
    if (url.pathname === "/api/v1/apps/acme/install") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          kind: "app",
          slug: "acme",
          name: "Acme",
          version: url.searchParams.get("version"),
          commitSha: installCommit,
          tarballUrl: `https://codeload.github.com/acme/mixos-apps/tar.gz/${installCommit}`,
          contentHash: "sha256-x",
          subpath: "apps/acme",
          permissions: [{ scope: "network:api.acme.example", reason: "Reads boards‮ from Acme." }],
        }),
      );
      return;
    }
    asked.push(url.pathname);
    res.writeHead(404).end("{}");
  });
  let origin = "";
  /** The paths the catalogue was asked, other than the install manifest. */
  let asked: string[] = [];
  const before = process.env.MIXOS_REPOSITORY_URL;

  beforeEach(async () => {
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.MIXOS_REPOSITORY_URL = origin;
    installCommit = sha;
    answering = true;
    asked = [];
  });
  afterEach(() => {
    if (before === undefined) delete process.env.MIXOS_REPOSITORY_URL;
    else process.env.MIXOS_REPOSITORY_URL = before;
  });
  after(() => server.close());

  function reviewFrom(source: string) {
    pend("app", "acme");
    const review = reviewPendingInstall(root, "app", "acme");
    return { ...review, release: { ...review.release, source } };
  }

  test("come from the catalogue it was installed from, for the installed version, and nothing else is asked", async () => {
    const facts = await listingFacts(reviewFrom(origin));
    assert.deepEqual(facts, {
      state: "ok",
      origin,
      claims: [{ scope: "network:api.acme.example", reason: "Reads boards from Acme." }],
      note: null,
    });
    // The source link is the record's: the listing isn't asked for it.
    assert.deepEqual(asked, []);
  });

  test("say when the catalogue now names another commit, while the review links to the one installed", async () => {
    installCommit = "d".repeat(40);
    const review = reviewFrom(origin);
    const facts = await listingFacts(review);
    assert.equal(facts.state, "ok");
    assert.match(facts.state === "ok" ? (facts.note ?? "") : "", /now lists commit dddddddddddd/);
    assert.equal(review.sourceUrl, `https://github.com/acme/mixos-apps/tree/${sha}/apps/acme`);
  });

  test("aren't asked of a different catalogue than the one it came from", async () => {
    const facts = await listingFacts(reviewFrom("https://mixos.org"));
    assert.equal(facts.state, "unavailable");
    assert.match(facts.state === "unavailable" ? facts.message : "", /installed from https:\/\/mixos\.org/);
  });

  test("leave the review standing when the catalogue doesn't answer", async () => {
    answering = false;
    const facts = await listingFacts(reviewFrom(origin));
    assert.equal(facts.state, "unavailable");
    assert.match(facts.state === "unavailable" ? facts.message : "", /Read the code in \.mixos\/pending\/apps\/acme\//);
  });
});
