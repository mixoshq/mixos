/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release notice as the admin pages render it, on the server: the notes
 * without HTML, images or working links, by the rule mixos.org's release pages
 * follow (its packages/cli/test/core-release-notes.test.ts has the same
 * cases), and only the two links built from the tag. `/mixos upgrade` first,
 * for every repository, with a copy button, and the merge by hand for the
 * notice's own tag. Then what the GitHub App's offer adds, and that nothing in
 * the check or the notice could apply a release: one button copies the
 * command, and the only other one opens a pull request, and nothing more.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateOffer } from "@/lib/github/outcomes";
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

/** Each button's text, in order. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]));

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
  assert.match(html, /<section id="new-release" aria-label="A new release of MixOS"/);
  // Collapsed until asked for.
  assert.match(html, /<details[^>]*><summary[^>]*>Release notes<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);

  const links = [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], text(m[2])]);
  assert.deepEqual(links, [
    ["https://mixos.org/docs/releases/v0.5.0", "v0.5.0 on mixos.org (opens in a new tab)"],
    ["https://mixos.org/docs/install/after-you-install/upgrading", "How to upgrade (opens in a new tab)"],
  ]);
  for (const a of html.match(/<a\s[^>]*>/g) ?? []) {
    assert.match(a, /target="_blank"/);
    assert.match(a, /rel="noreferrer noopener"/);
  }
  // `/mixos upgrade` first, to copy; then the merge by hand, for this tag, collapsed.
  assert.match(
    text(html),
    /How to upgrade \(opens in a new tab\) To upgrade, run \/mixos upgrade in Claude Code, in your copy of MixOS\. Copy Or merge it by hand On a branch, in a checkout of your repository, as How to upgrade says: git fetch upstream --tags && git merge v0\.5\.0$/,
  );
  assert.match(html, /<details[^>]*data-merge-by-hand[^>]*><summary[^>]*>Or merge it by hand<\/summary>/);
  // No apply button, nor anything else to press: the one button copies the command.
  assert.deepEqual(buttons(html), ["Copy"]);
  assert.doesNotMatch(html, /<form|<input(?![^>]*type="checkbox")/);
  assert.doesNotMatch(html, /evil\.example\/patch"/);
});

test("a release with no notes has no notes to expand, and the merge by hand still names its tag", () => {
  const notice = describeRelease({ ...RELEASE, tag: "v0.4.3", notes: "  \n" }, "stable", "0.4.2");
  assert.ok(notice);
  const html = renderToStaticMarkup(createElement(ReleaseNotice, { notice }));
  assert.doesNotMatch(html, /<summary[^>]*>Release notes/);
  assert.match(text(html), /A patch release: fixes\. v0\.4\.3 on mixos\.org/);
  assert.match(text(html), /git fetch upstream --tags && git merge v0\.4\.3$/);
  assert.doesNotMatch(html, /v0\.5\.0/);
});

// ── what the GitHub App's offer adds ────────────────────────────────────────

const links = (html: string) => [...html.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map((m) => m[1]);
const render = (offer: UpdateOffer | null) => {
  const notice = describeRelease(RELEASE, "stable", "0.4.2");
  assert.ok(notice);
  return renderToStaticMarkup(createElement(ReleaseNotice, { notice, offer }));
};

test("without the App: /mixos upgrade to copy, the merge by hand, and nothing else to press", () => {
  const html = render(null);
  assert.equal(html, renderToStaticMarkup(createElement(ReleaseNotice, { notice: describeRelease(RELEASE, "stable", "0.4.2")! })));
  assert.match(text(html), /To upgrade, run \/mixos upgrade in Claude Code, in your copy of MixOS\. Copy/);
  assert.match(text(html), /git fetch upstream --tags && git merge v0\.5\.0/);
  assert.deepEqual(buttons(html), ["Copy"]);
  assert.doesNotMatch(html, /<form|data-update-offer/);
});

test("on a fork of upstream: /mixos upgrade to copy, beside the one button that opens a pull request, and nothing else to press", () => {
  const html = render({
    kind: "fork",
    tag: "v0.5.0",
    commitSha: RELEASE.commitSha,
    repository: "acme/mixos",
    defaultBranch: "main",
    branch: "mixos/update-v0.5.0",
    title: "Update MixOS to v0.5.0 [skip preview]",
    off: null,
    compareUrl: "https://github.com/mixoshq/mixos/compare/v0.4.2...v0.5.0",
  });
  // Beside /mixos upgrade: the copy button, then the App's one, which opens a pull request.
  assert.deepEqual(buttons(html), ["Copy", "Open an update pull request"]);
  const open = (html.match(/<button[^>]*>/g) ?? [])[1];
  assert.doesNotMatch(open, /\sdisabled(?:=""|\s|>)/);
  assert.match(text(html), /To upgrade, run \/mixos upgrade in Claude Code, in your copy of MixOS\. Copy Open an update pull request/);
  assert.match(text(html), /git fetch upstream --tags && git merge v0\.5\.0/);
  assert.doesNotMatch(html, /<form|<input/);
  assert.match(html, /data-update-offer="fork"/);
  // Only the two links built from the tag: the compare link is the fallback, not a third link here.
  assert.deepEqual(links(html), ["https://mixos.org/docs/releases/v0.5.0", "https://mixos.org/docs/install/after-you-install/upgrading"]);

  // Off, as Browse's Propose is, until the rule and the checklist hold: the button, disabled, says why.
  const off = render({
    kind: "fork",
    tag: "v0.5.0",
    commitSha: RELEASE.commitSha,
    repository: "acme/mixos",
    defaultBranch: "main",
    branch: "mixos/update-v0.5.0",
    title: "Update MixOS to v0.5.0 [skip preview]",
    off: "Confirm on Developers > GitHub App that no host builds previews of the App's branches.",
    compareUrl: null,
  });
  assert.match((off.match(/<button[^>]*>/g) ?? [])[1], /\sdisabled(?:=""|\s|>)/);
  assert.match(text(off), /Opening one is off for now\. Confirm on Developers > GitHub App that no host builds previews of the App's branches\./);
});

test("on a private copy: /mixos upgrade to copy, the merge by hand with the compare link, and nothing else to press", () => {
  const html = render({
    kind: "copy",
    tag: "v0.5.0",
    repository: "acme-org/intranet",
    compareUrl: "https://github.com/mixoshq/mixos/compare/0123456789abcdef0123456789abcdef01234567...v0.5.0",
    command: "git fetch upstream --tags && git merge v0.5.0",
  });
  assert.deepEqual(buttons(html), ["Copy"]);
  assert.doesNotMatch(html, /<form|<input/);
  assert.match(text(html), /To upgrade, run \/mixos upgrade in Claude Code, in your copy of MixOS\. Copy Or merge it by hand/);
  assert.match(text(html), /as How to upgrade says: git fetch upstream --tags && git merge v0\.5\.0 What changed, on GitHub \(opens in a new tab\)$/);
  assert.deepEqual(links(html), [
    "https://mixos.org/docs/releases/v0.5.0",
    "https://mixos.org/docs/install/after-you-install/upgrading",
    "https://github.com/mixoshq/mixos/compare/0123456789abcdef0123456789abcdef01234567...v0.5.0",
  ]);
  assert.doesNotMatch(render({ kind: "copy", tag: "v0.5.0", repository: "acme-org/intranet", compareUrl: null, command: "git fetch upstream --tags && git merge v0.5.0" }), /compare/);
});

test("once a pull request was opened from here: say so, link to it, and offer nothing else", () => {
  const html = render({
    kind: "proposed",
    tag: "v0.5.0",
    repository: "acme/mixos",
    number: 7,
    url: "https://github.com/acme/mixos/pull/7",
    at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    by: "admin@example.com",
  });
  assert.deepEqual(buttons(html), ["Copy"]);
  assert.doesNotMatch(html, /<form|<input/);
  assert.match(text(html), /Pull request #7 \(opens in a new tab\) for v0\.5\.0 was opened on acme\/mixos .* by admin@example\.com\. Developers > GitHub App lists it with its checks\. Merging it is the deploy\./);
  assert.deepEqual(links(html), [
    "https://mixos.org/docs/releases/v0.5.0",
    "https://mixos.org/docs/install/after-you-install/upgrading",
    "https://github.com/acme/mixos/pull/7",
  ]);
});

test("the status line links to what is sent", () => {
  const html = renderToStaticMarkup(
    createElement(ReleaseCheckStatus, { status: "Checked mixos.org for new releases 3 hours ago." }),
  );
  assert.equal(text(html), "Checked mixos.org for new releases 3 hours ago. What's sent (opens in a new tab)");
  assert.match(html, /href="https:\/\/mixos\.org\/docs\/security\/surface#the-release-check"/);
});

// ── never applied ───────────────────────────────────────────────────────────

test("nothing in the check or its notice can apply a release: no process, no file, a button that copies, and one that opens a pull request", () => {
  const root = path.resolve(__dirname, "../../..");
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
  // Imports only: comments may name what isn't done.
  const importsOf = (source: string) => source.split("\n").filter((line) => /^\s*(import|export .* from)\b/.test(line)).join("\n");
  const NEVER = /child_process|node:fs|["']fs["']|repository\/(install|register|pending)["']/;

  const files = [
    "src/lib/platform/release-check.ts",
    "src/lib/platform/releases.ts",
    "src/components/admin/release-notice.tsx",
    "src/components/admin/release-notes.tsx",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(importsOf(source), NEVER, file);
    assert.doesNotMatch(importsOf(source), /actions["']/, file);
    assert.doesNotMatch(source, /"use server"|<button|<Button[\s>]|<form|formAction|onClick/, file);
  }

  // Two buttons, on purpose, each from its own file. The copy button writes
  // `/mixos upgrade` to the clipboard and does nothing else. The update pull
  // request button's only action opens a pull request through the GitHub App
  // (src/lib/github/update-pull.ts), which can create a branch and a pull
  // request and nothing else (./repository.ts's ref-only scope,
  // src/lib/github/repository.test.ts). Nothing merges, and nothing runs or
  // writes on this instance.
  const notice = read("src/components/admin/release-notice.tsx");
  assert.deepEqual(notice.match(/<[A-Za-z]*Button\b/g), ["<CopyButton", "<UpdatePullRequestButton"]);
  const copy = read("src/components/admin/copy-button.tsx");
  assert.doesNotMatch(importsOf(copy), NEVER);
  assert.doesNotMatch(copy, /"use server"|actions["']|<form|formAction|fetch\(/);
  assert.deepEqual(copy.match(/navigator\.[a-z]+\.[A-Za-z]+/g), ["navigator.clipboard.writeText"]);
  const button = read("src/components/admin/update-pull-request.tsx");
  assert.deepEqual(button.match(/from "@\/lib\/github\/[a-z-]*actions"/g), ['from "@/lib/github/update-pull-actions"']);
  assert.match(button, /proposeMixOSUpdateAction\(\{ tag: offer\.tag \}\)/);
  for (const file of [
    "src/components/admin/update-pull-request.tsx",
    "src/lib/github/update-pull-actions.ts",
    "src/lib/github/update-pull.ts",
    "src/lib/github/update-pull-body.ts",
  ]) {
    assert.doesNotMatch(importsOf(read(file)), NEVER, file);
  }
  // Its writes are two POSTs, to git/refs and pulls, and no path that merges.
  const work = read("src/lib/github/update-pull.ts");
  assert.deepEqual([...work.matchAll(/repo\.post\("([^"]+)"/g)].map((m) => m[1]).sort(), ["/git/refs", "/pulls"]);
  for (const never of ['"/merges"', "merge-upstream", '/merge"', "auto_merge", 'method: "P']) {
    assert.ok(!work.includes(never), `${never} in update-pull.ts`);
  }
});
