/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The banner over every page for admins (./release-banner.tsx): who sees it,
 * when, what it says, that dismissing it lasts until the next release, which
 * layouts render it, and that it applies nothing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dismissalFor, releaseBannerFor } from "@/lib/platform/release-banner";
import { describeRelease, describeReleaseCheck, type ReleaseCheckState } from "@/lib/platform/releases";
import type { CoreRelease } from "@/lib/repository/types";
import { RELEASE_NOTICE_URL, ReleaseBannerView } from "./release-banner";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const release = (tag: string, prerelease = false): CoreRelease => ({
  tag,
  commitSha: "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  publishedAt: "2026-10-20T09:00:00Z",
  prerelease,
  notes: "### Features\n\n- feat(os): a thing (abc1234)",
});

const ADMIN = "5a0b8a0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER = "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c";

/** The notice the admin pages would show, as the banner gets it. */
const noticeOf = (latest: CoreRelease | null, current = "0.2.0") => describeRelease(latest, "stable", current);

describe("who sees the banner, and when", () => {
  test("an admin, when a newer release is out: its tag and this build's", () => {
    const banner = releaseBannerFor({ isAdmin: true, userId: ADMIN, notice: noticeOf(release("v0.3.0")), current: "0.2.0", dismissed: undefined });
    assert.deepEqual(banner, { tag: "v0.3.0", current: "v0.2.0" });
  });

  test("not anyone else, whatever the release", () => {
    for (const userId of [ADMIN, null]) {
      assert.equal(releaseBannerFor({ isAdmin: false, userId, notice: noticeOf(release("v0.3.0")), current: "0.2.0", dismissed: undefined }), null);
    }
  });

  test("not when nothing is newer: the same release, an older one, or a prerelease on stable", () => {
    for (const latest of [release("v0.2.0"), release("v0.1.0"), release("v0.3.0-rc.1", true)]) {
      assert.equal(releaseBannerFor({ isAdmin: true, userId: ADMIN, notice: noticeOf(latest), current: "0.2.0", dismissed: undefined }), null, latest.tag);
    }
  });

  test("not with the update check off, nor before it has answered", () => {
    const state: ReleaseCheckState = {
      channel: "stable",
      latest: release("v0.3.0"),
      lastAttemptAt: "2026-10-20T08:00:00Z",
      lastSuccessAt: "2026-10-20T08:00:00Z",
      lastError: null,
      nextCheckAt: "2026-10-21T08:00:00Z",
    } as ReleaseCheckState;
    const base = { channel: "stable" as const, current: "0.2.0", host: "mixos.org", now: new Date("2026-10-20T10:00:00Z") };
    const on = describeReleaseCheck({ ...base, enabled: true, state });
    assert.ok(releaseBannerFor({ isAdmin: true, userId: ADMIN, notice: on.notice, current: "0.2.0", dismissed: undefined }));
    for (const view of [describeReleaseCheck({ ...base, enabled: false, state }), describeReleaseCheck({ ...base, enabled: true, state: null })]) {
      assert.equal(view.notice, null);
      assert.equal(releaseBannerFor({ isAdmin: true, userId: ADMIN, notice: view.notice, current: "0.2.0", dismissed: undefined }), null);
    }
  });

  test("dismissed, it stays gone for that admin and that release, and a newer release brings it back", () => {
    const dismissed = dismissalFor(ADMIN, "v0.3.0");
    assert.equal(dismissed, `${ADMIN}:v0.3.0`);
    assert.equal(releaseBannerFor({ isAdmin: true, userId: ADMIN, notice: noticeOf(release("v0.3.0")), current: "0.2.0", dismissed }), null);
    assert.deepEqual(
      releaseBannerFor({ isAdmin: true, userId: ADMIN, notice: noticeOf(release("v0.4.0")), current: "0.2.0", dismissed }),
      { tag: "v0.4.0", current: "v0.2.0" },
    );
    // Another admin in the same browser hasn't dismissed it.
    assert.ok(releaseBannerFor({ isAdmin: true, userId: OTHER, notice: noticeOf(release("v0.3.0")), current: "0.2.0", dismissed }));
    // A value that isn't a dismissal changes nothing.
    assert.ok(releaseBannerFor({ isAdmin: true, userId: ADMIN, notice: noticeOf(release("v0.3.0")), current: "0.2.0", dismissed: "v0.3.0" }));
  });
});

describe("what it says", () => {
  const html = renderToStaticMarkup(createElement(ReleaseBannerView, { banner: { tag: "v0.3.0", current: "v0.2.0" } }));

  test("the release, this build, and /mixos upgrade to copy, with the details on the admin pages", () => {
    assert.equal(
      text(html),
      "MixOS v0.3.0 is out (you run v0.2.0). Run /mixos upgrade in Claude Code to upgrade. Copy Details",
    );
    assert.match(html, /<code[^>]*>\/mixos upgrade<\/code>/);
    assert.equal(RELEASE_NOTICE_URL, "/admin/apps#new-release");
    assert.deepEqual([...html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map((m) => m[1]), ["/admin/apps#new-release"]);
  });

  test("a region with a name, and two buttons, the dismiss one named for a screen reader", () => {
    assert.match(html, /^<section aria-label="A newer release of MixOS" data-release-banner="v0\.3\.0"/);
    const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)];
    assert.equal(buttons.length, 2);
    assert.equal(text(buttons[0][2]), "Copy");
    assert.match(buttons[1][1], /aria-label="Dismiss until the next release"/);
    assert.match(buttons[1][1], /type="button"/);
  });

  test("it wraps on a phone: the line and its controls wrap, and nothing is wider than the screen", () => {
    assert.match(html, /flex min-w-0 flex-1 flex-wrap/);
    assert.doesNotMatch(html, /\bw-\[|min-w-\[|whitespace-nowrap/);
  });
});

describe("where it renders, and what it can do", () => {
  const root = path.resolve(__dirname, "../../..");
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

  test("in the main interface's layout, above the menu bar; not in the sign-in, public or app-password pages", () => {
    const main = read("src/app/(main)/layout.tsx");
    assert.match(main, /\{\/\*[^]*?\*\/\}\s*<ReleaseBanner isAdmin=\{session\.user\.isAdmin\} userId=\{session\.user\.id\} \/>\s*<HeaderShell[^>]*\/>/);
    const others = ["src/app/layout.tsx", "src/app/(public)/layout.tsx"];
    for (const dir of ["src/app/(auth)", "src/app/(public)"]) {
      for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true }) as string[]) {
        if (/\.tsx?$/.test(entry)) others.push(path.join(dir, entry));
      }
    }
    for (const file of others) assert.doesNotMatch(read(file), /release-banner|ReleaseBanner/, file);
  });

  test("it applies nothing: its one action sets the dismissal cookie, for an admin", () => {
    const NEVER = /child_process|node:fs|["']fs["']|repository\/(install|register|pending)["']|update-pull/;
    for (const file of [
      "src/components/admin/release-banner.tsx",
      "src/components/admin/release-banner-shell.tsx",
      "src/lib/platform/release-banner.ts",
      "src/lib/platform/release-banner-actions.ts",
    ]) {
      assert.doesNotMatch(read(file), NEVER, file);
    }
    const action = read("src/lib/platform/release-banner-actions.ts");
    assert.equal(action.match(/export async function/g)?.length, 1);
    assert.equal(action.match(/\.set\(/g)?.length, 1);
    assert.match(action, /session\?\.user\.isAdmin !== true \|\| !isReleaseTag\(tag\)\) return;/);
    assert.match(action, /httpOnly: true/);
  });
});
