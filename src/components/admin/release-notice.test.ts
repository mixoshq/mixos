/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release notice as the admin pages render it, on the server: the notes
 * without HTML, images or working links, by the rule mixos.org's release pages
 * follow (its packages/cli/test/core-release-notes.test.ts has the same
 * cases), and only the two links built from the tag. Then that nothing in the
 * check or the notice could apply a release.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describeRelease } from "@/lib/platform/releases";
import type { CoreRelease } from "@/lib/repository/types";
import ReleaseNotice, { ReleaseCheckStatus } from "./release-notice";
import ReleaseNotes, { notesUrl } from "./release-notes";

/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const notes = (markdown: string) => renderToStaticMarkup(createElement(ReleaseNotes, null, markdown));

const HOSTILE = [
  "### Fixes",
  "",
  "- fix(os): [apply the security patch](https://evil.example/patch) (#12)",
  "- docs: see <https://example.com/a> or https://example.com/b",
  "- fix: [click me](javascript:alert(1))",
  '- chore: ![pixel](https://tracker.example/p.png)<img src="https://tracker.example/q.png" onerror="alert(1)">',
  '- feat: a <b onclick="alert(1)">bold</b> claim and [a reference][ref]',
  "",
  "<script>alert(1)</script>",
  "",
  "[ref]: https://example.com/ref",
].join("\n");

test("notes render without raw HTML or images, and every link becomes text", () => {
  const html = notes(HOSTILE);

  assert.doesNotMatch(html, /<a[\s>]/, "no link survives");
  assert.doesNotMatch(html, /<img|<picture|<source|<script|<b[\s>]|onerror|onclick|javascript:|tracker\.example|alert/i);
  const seen = text(html);
  assert.match(seen, /Fixes fix\(os\): apply the security patch \(https:\/\/evil\.example\/patch\) \(#12\)/);
  assert.match(seen, /docs: see https:\/\/example\.com\/a or https:\/\/example\.com\/b fix:/);
  assert.match(seen, /fix: click me chore:/);
  assert.match(seen, /feat: a bold claim and a reference \(https:\/\/example\.com\/ref\)$/);
  // A heading is a bold line, not a heading of the page's.
  assert.doesNotMatch(html, /<h[1-6][\s>]/);
  assert.match(html, /<p class="[^"]*font-semibold[^"]*">Fixes<\/p>/);
});

test("the first release's notes read as text", () => {
  assert.equal(
    text(
      notes(
        "The first tagged release of MixOS. What changed on the way here is in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.1.0/WHATS-NEW.md).",
      ),
    ),
    "The first tagged release of MixOS. What changed on the way here is in WHATS-NEW.md (https://github.com/mixoshq/mixos/blob/v0.1.0/WHATS-NEW.md).",
  );
});

test("an address is shown once, only when worth showing", () => {
  const cases: Array<[string, string]> = [
    ["[the page](https://example.com/a)", "the page (https://example.com/a)"],
    ["<https://example.com/a>", "https://example.com/a"],
    ["www.example.com", "www.example.com"],
    ["<ops@example.com>", "ops@example.com"],
    ["[write to us](mailto:ops@example.com)", "write to us (mailto:ops@example.com)"],
    ["[the guide](docs/upgrading.md)", "the guide (docs/upgrading.md)"],
    ["[above](#fixes)", "above"],
    ["[chat](irc://irc.example.org/mixos)", "chat"],
    ["[run](JaVaScRiPt:alert(1))", "run"],
    ["[data](data:text/html,<b>x</b>)", "data"],
    ["[![logo](https://tracker.example/l.png)](https://example.com/)", "(https://example.com/)"],
  ];
  for (const [markdown, shown] of cases) {
    const html = notes(markdown);
    assert.equal(text(html), shown, markdown);
    assert.doesNotMatch(html, /<a[\s>]|<img/, markdown);
  }
  assert.equal(notesUrl("https://example.com/a?b=c:d"), "https://example.com/a?b=c:d");
  assert.equal(notesUrl("vbscript:msgbox"), "");
  assert.equal(notesUrl("./a:b"), "./a:b");
});

const RELEASE: CoreRelease = {
  tag: "v0.5.0",
  commitSha: "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
  publishedAt: "2026-10-20T09:00:00Z",
  prerelease: false,
  notes: HOSTILE,
};

test("the notice: the sentence, the notes collapsed, and the two links built from the tag", () => {
  const notice = describeRelease(RELEASE, "stable", "0.4.2");
  assert.ok(notice);
  const html = renderToStaticMarkup(createElement(ReleaseNotice, { notice }));

  assert.match(
    text(html),
    /^MixOS 0\.5\.0 is available \(this instance runs 0\.4\.2\)\. A minor release: it may need changes\. Release notes /,
  );
  assert.match(html, /<section aria-label="A new release of MixOS"/);
  // Collapsed until asked for.
  assert.match(html, /<details[^>]*><summary[^>]*>Release notes<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);

  const links = [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], text(m[2])]);
  assert.deepEqual(links, [
    ["https://mixos.org/docs/releases/v0.5.0", "v0.5.0 on mixos.org (opens in a new tab)"],
    ["https://mixos.org/docs/operating/upgrading", "How to upgrade (opens in a new tab)"],
  ]);
  for (const a of html.match(/<a\s[^>]*>/g) ?? []) {
    assert.match(a, /target="_blank"/);
    assert.match(a, /rel="noreferrer noopener"/);
  }
  // No apply button, nor anything else to press.
  assert.doesNotMatch(html, /<button|<form|<input(?![^>]*type="checkbox")/);
  assert.doesNotMatch(html, /evil\.example\/patch"/);
});

test("a release with no notes has nothing to expand", () => {
  const notice = describeRelease({ ...RELEASE, notes: "  \n" }, "stable", "0.4.2");
  assert.ok(notice);
  const html = renderToStaticMarkup(createElement(ReleaseNotice, { notice }));
  assert.doesNotMatch(html, /<details/);
  assert.match(text(html), /A minor release: it may need changes\. v0\.5\.0 on mixos\.org/);
});

test("the status line links to what is sent", () => {
  const html = renderToStaticMarkup(
    createElement(ReleaseCheckStatus, { status: "Checked mixos.org for new releases 3 hours ago." }),
  );
  assert.equal(text(html), "Checked mixos.org for new releases 3 hours ago. What's sent (opens in a new tab)");
  assert.match(html, /href="https:\/\/mixos\.org\/docs\/security\/surface#the-release-check"/);
});

// ── never applied ───────────────────────────────────────────────────────────

test("nothing in the check or its notice can apply a release: no process, no file, no button", () => {
  const root = path.resolve(__dirname, "../../..");
  const files = [
    "src/lib/platform/release-check.ts",
    "src/lib/platform/releases.ts",
    "src/components/admin/release-notice.tsx",
    "src/components/admin/release-notes.tsx",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    // Imports only: comments may name what isn't done.
    const imports = source.split("\n").filter((line) => /^\s*(import|export .* from)\b/.test(line)).join("\n");
    assert.doesNotMatch(
      imports,
      /child_process|node:fs|["']fs["']|actions["']|repository\/(install|register|pending)["']/,
      file,
    );
    assert.doesNotMatch(source, /"use server"|<button|<Button|<form|formAction|onClick/, file);
  }
});
