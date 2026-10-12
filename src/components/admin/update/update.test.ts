/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the update dialog renders, on the server: the picker, the comparison
 * with the release picked, the local changes, and the result. The dialog's
 * data comes from its actions (src/lib/repository/update-admin.ts, tested in
 * src/lib/repository/install-update.test.ts); these give it their own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { FloorVerdict } from "@/lib/platform/version-floor";
import type { LocalChanges } from "@/lib/repository/update";
import type { PreparedUpdate, UpdateComparison, UpdateOverview } from "@/lib/repository/update-outcomes";
import UpdateDialog, { ComparisonView, LocalChangesView, PreparedView, ReleasePicker } from "./update-dialog";

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
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const A = "a".repeat(40);
const B = "b".repeat(40);
const met: FloorVerdict = { declared: "0.1.0", current: "0.1.0", where: "checkout", met: true, checked: true, reason: null };

function comparison(over: Partial<UpdateComparison> = {}): UpdateComparison {
  return {
    kind: "app",
    slug: "board",
    name: "Board",
    path: "apps/board",
    host: "mixos.org",
    from: { version: "1.2.0", gitTag: "v1.2.0", commitSha: A, releasedAt: "2026-10-01T12:00:00.000Z", sourceUrl: `https://github.com/acme/board/tree/${A}` },
    to: {
      version: "1.3.0",
      gitTag: "v1.3.0",
      commitSha: B,
      releasedAt: "2026-10-08T12:00:00.000Z",
      sourceUrl: `https://github.com/acme/board/tree/${B}`,
      contentHash: "sha256-xyz",
      yanked: false,
      yankedReason: null,
    },
    direction: "newer",
    compareUrl: `https://github.com/acme/board/compare/${A}...${B}`,
    otherRepository: null,
    floor: met,
    claims: { state: "ok", added: [{ scope: "network:files.example.com", reason: "Uploads attachments." }], removed: [], changed: [] },
    declarations: [
      { label: "Egress", added: ["files.example.com"], removed: [] },
      { label: "Env", added: ["BOARD_TOKEN (secret)"], removed: ["OLD_KEY"] },
    ],
    migrations: { added: ["0002_tags.sql"], changed: [], lacking: [] },
    localChanges: false,
    needs: { discardLocalChanges: false, allowOlder: false, allowYanked: false },
    blocker: null,
    reviewed: { installedCommit: A, installedFilesHash: "sha256-a", folderHash: "sha256-a", targetCommit: B, targetContentHash: "sha256-xyz" },
    ...over,
  };
}

const view = (c: UpdateComparison) =>
  render(
    createElement(ComparisonView, { comparison: c, older: false, onOlder: () => {}, withdrawn: false, onWithdrawn: () => {} }),
  );

test("a newer release: both releases, the compare link, and what changes", () => {
  const html = view(comparison());
  const seen = text(html);
  assert.match(seen, /Installed Version 1\.2\.0 \(v1\.2\.0\) Commit aaaaaaaaaaaa .* Published 1 Oct 2026/);
  assert.match(seen, /Update to Version 1\.3\.0 \(v1\.3\.0\) Commit bbbbbbbbbbbb .* Published 8 Oct 2026/);
  assert.ok(html.includes(`href="https://github.com/acme/board/compare/${A}...${B}"`));
  assert.match(seen, /Compare 1\.2\.0 and 1\.3\.0 on GitHub/);
  assert.match(seen, /What the publisher says it needs Their words on mixos\.org, not a guarantee\. Now claims network:files\.example\.com Uploads attachments\./);
  assert.match(seen, /Egress Adds files\.example\.com/);
  assert.match(seen, /Env Adds BOARD_TOKEN \(secret\) Drops OLD_KEY Saved settings carry over\./);
  assert.match(seen, /New in 1\.3\.0 migrations\/0002_tags\.sql The release step applies them, and they are forward-only: back up the database first\./);
  assert.match(seen, /Requires MixOS 0\.1\.0 or newer\. This checkout runs 0\.1\.0, which meets it\./);
  // Nothing to say yes to for a newer, published release.
  assert.doesNotMatch(seen, /Install an older release|Install it anyway/);
});

test("an older release needs Install an older release, and says the database stays at the newer schema", () => {
  const seen = text(
    view(
      comparison({
        direction: "older",
        to: { ...comparison().to, version: "a1b2c3d", gitTag: null },
        compareUrl: `https://github.com/acme/board/compare/${B}...${A}`,
        migrations: { added: [], changed: [], lacking: ["0002_pins.sql"] },
        needs: { discardLocalChanges: false, allowOlder: true, allowYanked: false },
      }),
    ),
  );
  assert.match(seen, /a1b2c3d is older than 1\.2\.0 Installing it goes back to an earlier release\. Install an older release\./);
  assert.match(seen, /In apps\/board\/ and not in a1b2c3d migrations\/0002_pins\.sql A database that ran them stays at the newer schema/);
  assert.match(seen, /restoring a backup of the database may be the better way back/);
});

test("when which is newer can't be told, it is chosen as an older release", () => {
  const seen = text(
    view(comparison({ direction: "unknown", needs: { discardLocalChanges: false, allowOlder: true, allowYanked: false } })),
  );
  assert.match(seen, /Which of 1\.2\.0 and 1\.3\.0 is newer can't be told/);
  assert.match(seen, /mixos\.org doesn't give a date for both, so it may be an older release\. Install an older release\./);
});

test("a withdrawn release, another repository, and a floor this checkout doesn't meet", () => {
  const unmet: FloorVerdict = { ...met, declared: "9.0.0", met: false };
  const seen = text(
    view(
      comparison({
        to: { ...comparison().to, yanked: true, yankedReason: "Corrupts boards." },
        needs: { discardLocalChanges: false, allowOlder: false, allowYanked: true },
        compareUrl: null,
        otherRepository: { from: "acme/board", to: "someone-else/board" },
        floor: unmet,
      }),
    ),
  );
  assert.match(seen, /1\.3\.0 was withdrawn by its publisher Corrupts boards\. Install it anyway\./);
  assert.match(seen, /It comes from another repository 1\.3\.0 is published from someone-else\/board, and 1\.2\.0 came from acme\/board\./);
  assert.match(seen, /Requires MixOS 9\.0\.0 or newer\. This checkout runs 0\.1\.0, which doesn't meet it\. Upgrade MixOS to install this release\./);
  assert.doesNotMatch(seen, /Compare 1\.2\.0 and 1\.3\.0 on GitHub/);
});

test("claims that can't be read, manifests that can't be compared, and a connector with no migrations", () => {
  const seen = text(
    view(
      comparison({
        kind: "connector",
        claims: { state: "unavailable", message: "mixos.org couldn't be asked for the publisher's claims." },
        declarations: null,
      }),
    ),
  );
  assert.match(seen, /mixos\.org couldn't be asked for the publisher's claims\./);
  assert.match(seen, /One of the two manifests can't be read, so they can't be compared\./);
  assert.doesNotMatch(seen, /Migrations/);
});

test("local changes are listed against the installed release, with what isn't counted, and need discarding", () => {
  const local: LocalChanges = {
    state: "listed",
    changed: ["README.md"],
    added: ["api/items/extra.ts"],
    removed: ["lib/old.ts"],
    more: { changed: 0, added: 3, removed: 0 },
    ignored: ["lastUpdated", "git-files"],
    incomplete: false,
  };
  const seen = text(
    render(createElement(LocalChangesView, { local, path: "apps/board", version: "1.2.0", discard: false, onDiscard: () => {} })),
  );
  assert.match(seen, /Your changes apps\/board\/ has changed since 1\.2\.0 was installed\. Updating replaces its files/);
  assert.match(seen, /Changed README\.md Added api\/items\/extra\.ts and 3 more Deleted lib\/old\.ts/);
  assert.match(seen, /Not listed, since it doesn't change what runs: its manifest's lastUpdated, which the pre-commit stamp writes; git control files/);
  assert.match(seen, /Discard my changes to apps\/board\/\./);

  const unlisted = text(
    render(
      createElement(LocalChangesView, {
        local: { state: "unlisted", reason: "GitHub didn't serve 1.2.0 at commit aaaaaaaaaaaa, so the files that changed can't be named." },
        path: "apps/board",
        version: "1.2.0",
        discard: false,
        onDiscard: () => {},
      }),
    ),
  );
  assert.match(unlisted, /so the files that changed can't be named\. Discard my changes to apps\/board\/\./);
  assert.equal(
    render(createElement(LocalChangesView, { local: { state: "none" }, path: "apps/board", version: "1.2.0", discard: false, onDiscard: () => {} })),
    "",
  );
});

test("the picker lists each release with its date and which way it goes", () => {
  const overview: UpdateOverview = {
    kind: "app",
    slug: "board",
    name: "Board",
    path: "apps/board",
    host: "mixos.org",
    installed: { version: "1.2.0", gitTag: "v1.2.0", commitSha: A, releasedAt: "2026-10-01T12:00:00.000Z", sourceUrl: null, yanked: true, yankedReason: "Loses edits." },
    local: { state: "none" },
    releases: [
      { version: "1.4.0", gitTag: "v1.4.0", commitSha: "c".repeat(40), releasedAt: "2026-10-10T12:00:00.000Z", yanked: true, current: false, direction: "newer" },
      { version: "1.3.0", gitTag: "v1.3.0", commitSha: B, releasedAt: "2026-10-08T12:00:00.000Z", yanked: false, current: true, direction: "newer" },
      { version: "1.2.0", gitTag: "v1.2.0", commitSha: A, releasedAt: "2026-10-01T12:00:00.000Z", yanked: true, current: false, direction: "same" },
      { version: "c0ffee1", gitTag: null, commitSha: "d".repeat(40), releasedAt: null, yanked: false, current: false, direction: "unknown" },
    ],
    listingProblem: null,
    suggested: "1.3.0",
  };
  const seen = text(render(createElement(ReleasePicker, { overview, version: "1.3.0", onPick: () => {} })));
  assert.match(seen, /apps\/board\/ runs 1\.2\.0, published 1 Oct 2026, installed from mixos\.org\./);
  assert.match(seen, /1\.2\.0 was withdrawn by its publisher Loses edits\./);
  assert.match(seen, /Update to Choose a release 1\.4\.0 · 10 Oct 2026 · newer · withdrawn 1\.3\.0 · 8 Oct 2026 · newer · current/);
  assert.match(seen, /1\.2\.0 · 1 Oct 2026 · installed · withdrawn c0ffee1 · date unknown · order unknown/);
  // A tag that says more than the version is kept.
  const tagged = text(
    render(
      createElement(ReleasePicker, {
        overview: { ...overview, releases: [{ ...overview.releases[1], gitTag: "release-2026-10" }] },
        version: "1.3.0",
        onPick: () => {},
      }),
    ),
  );
  assert.match(tagged, /1\.3\.0 \(release-2026-10\) · 8 Oct 2026 · newer · current/);
});

test("the result says where the release waits, and what comes next", () => {
  const result: PreparedUpdate = {
    kind: "app",
    slug: "board",
    name: "Board",
    path: "apps/board",
    pendingPath: ".mixos/pending/apps/board",
    from: { version: "1.2.0", gitTag: "v1.2.0" },
    to: { version: "1.0.0", gitTag: "v1.0.0", commitSha: B },
    direction: "older",
    localChangesDiscarded: true,
    nextStep: "This version of MixOS can't register updates yet. Discard it in Admin > Apps, or with `npm run register -- app/board --discard`.",
  };
  const html = render(createElement(PreparedView, { result }));
  const seen = text(html);
  assert.match(seen, /1\.0\.0 downloaded and checked It waits in \.mixos\/pending\/apps\/board\/ , where none of its code runs, and apps\/board\/ is as it was\./);
  assert.match(seen, /From 1\.2\.0 To 1\.0\.0 · an older release/);
  assert.match(seen, /Your changes To be discarded when it is registered/);
  assert.ok(html.includes("<code class=\"font-mono text-xs\">npm run register -- app/board --discard</code>"));
});

test("the dialog starts by reading what is installed", () => {
  const seen = text(render(createElement(UpdateDialog, { target: { kind: "app", slug: "board", name: "Board" }, onClose: () => {} })));
  assert.match(seen, /Update Board App · board/);
  assert.match(seen, /Reading what is installed…/);
});
