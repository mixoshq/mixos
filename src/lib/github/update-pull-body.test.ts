/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BODY_CHARS, notesAsText, shownAddress, updateBody, type UpdateBodyInput } from "./update-pull-body";

/** The notice's hostile notes (src/components/admin/release-notice.test.ts), as mixos.org could publish them. */
const HOSTILE = [
  "### Fixes",
  "",
  "- fix(os): [apply the security patch](https://evil.example/patch) (#12)",
  "- docs: see <https://example.com/a> or https://example.com/b",
  "- fix: [click me](javascript:alert(1))",
  '- chore: ![pixel](https://tracker.example/p.png)<img src="https://tracker.example/q.png" onerror="alert(1)">',
  '- feat: a <b onclick="alert(1)">bold</b> claim and [a reference][ref]',
  "- cc @everyone, closes #3, and \\ a backslash",
  "",
  "<script>alert(1)</script>",
  "",
  "[ref]: https://example.com/ref",
].join("\n");

function input(over: Partial<UpdateBodyInput> = {}): UpdateBodyInput {
  return {
    tag: "v0.5.0",
    commitSha: "9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    publishedAt: "2026-10-20T09:00:00Z",
    notes: HOSTILE,
    current: "0.4.2",
    repository: "acme/mixos",
    defaultBranch: "main",
    compare: { ahead: 12, behind: 3, commits: 12, files: 48 },
    migrations: 2,
    host: "vercel",
    releaseUrl: "https://mixos.org/docs/releases/v0.5.0",
    upgradeUrl: "https://mixos.org/docs/operating/upgrading",
    ...over,
  };
}

/** The body's fenced block, and the body outside it. */
function split(body: string): { inside: string; outside: string } {
  const fence = /(`{3,})text\n([\s\S]*?)\n\1(?=\n|$)/.exec(body);
  assert.ok(fence, body);
  return { inside: fence![2], outside: body.replace(fence![0], "") };
}

describe("the notes as text", () => {
  test("links become their text and address, images and HTML go, and the rest is escaped", () => {
    assert.deepEqual(notesAsText(HOSTILE), [
      "Fixes",
      "",
      "- fix(os): apply the security patch (https://evil.example/patch) (\\#12)",
      "- docs: see https://example.com/a or https://example.com/b",
      "- fix: click me",
      "- chore:",
      "- feat: a bold claim and a reference (https://example.com/ref)",
      "- cc \\@everyone, closes \\#3, and \\\\ a backslash",
    ]);
  });

  test("an address is shown once, only when worth showing", () => {
    const cases: Array<[string, string]> = [
      ["[the page](https://example.com/a)", "the page (https://example.com/a)"],
      ["<https://example.com/a>", "https://example.com/a"],
      ["www.example.com", "www.example.com"],
      ["<ops@example.com>", "ops\\@example.com"],
      ["[write to us](mailto:ops@example.com)", "write to us (mailto:ops\\@example.com)"],
      ["[the guide](docs/upgrading.md)", "the guide (docs/upgrading.md)"],
      ["[above](#fixes)", "above"],
      ["[chat](irc://irc.example.org/mixos)", "chat"],
      ["[run](JaVaScRiPt:alert(1))", "run"],
      ["[data](data:text/html,<b>x</b>)", "data"],
      ["[![logo](https://tracker.example/l.png)](https://example.com/)", "(https://example.com/)"],
      ["[example.com](https://example.com)", "example.com"],
      ['[a title](https://example.com/t "The title")', "a title (https://example.com/t)"],
    ];
    for (const [markdown, shown] of cases) assert.deepEqual(notesAsText(markdown), [shown], markdown);
    assert.equal(shownAddress("https://example.com/a?b=c:d"), "https://example.com/a?b=c:d");
    assert.equal(shownAddress("vbscript:msgbox"), null);
    assert.equal(shownAddress("./a:b"), "./a:b");
    assert.equal(shownAddress("#fixes"), null);
  });

  test("blank lines collapse, control characters go, and long notes are cut short", () => {
    assert.deepEqual(notesAsText("a\n\n\n\nb\r\nc\u2028d\u0000e\n\n"), ["a", "", "b", "c d e"]);
    const long = Array.from({ length: 500 }, (_, i) => `- line ${i}`).join("\n");
    const lines = notesAsText(long);
    assert.equal(lines.length, 401);
    assert.equal(lines[400], "(cut short: 100 more lines)");
    const wide = notesAsText("x".repeat(1000));
    assert.equal(wide[0].length, 500);
    assert.ok(wide[0].endsWith("…"));
    assert.deepEqual(notesAsText(""), []);
  });
});

describe("a MixOS update's pull request body", () => {
  test("the notes are only in the fence, escaped; everything outside is this instance's", () => {
    const body = updateBody(input());
    const { inside, outside } = split(body);
    assert.ok(!/evil\.example|@everyone|#\d|<script|alert|tracker\.example|onerror/i.test(outside), outside);
    assert.match(inside, /^- fix\(os\): apply the security patch \(https:\/\/evil\.example\/patch\) \(\\#12\)$/m);
    assert.match(inside, /^- cc \\@everyone, closes \\#3/m);
    assert.ok(!/<script|onerror|tracker\.example|javascript:/i.test(inside), inside);
  });

  test("what was verified, GitHub's numbers, the checklist and the two links built here", () => {
    const body = updateBody(input());
    const { outside } = split(body);
    assert.match(outside, /^Updates MixOS to v0\.5\.0\. This instance runs 0\.4\.2\./);
    assert.match(outside, /Nothing here merges: merging it is the deploy\./);
    assert.match(outside, /\*\*Release:\*\* `v0\.5\.0`, published 2026-10-20, at commit `9f2b4c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39` on mixoshq\/mixos\./);
    assert.match(outside, /mixoshq\/mixos's tag `v0\.5\.0` is at that commit, and the commit is on its `main`/);
    assert.match(outside, /\*\*Against `main`:\*\* 12 commits ahead, 3 commits behind, 48 files changed/);
    assert.match(outside, /\*\*Workflows:\*\* none changed/);
    assert.match(outside, /\*\*Platform migrations:\*\* 2 files under `supabase\/migrations\/`/);
    assert.match(outside, /1\. \*\*Back up the database first\.\*\*/);
    assert.match(outside, /https:\/\/mixos\.org\/docs\/releases\/v0\.5\.0/);
    assert.match(outside, /https:\/\/mixos\.org\/docs\/operating\/upgrading/);
    assert.match(outside, /No CI ran|keeps workflows off until you turn them on/);
    assert.match(outside, /Vercel builds the merge and puts it into production\. The production build's release step applies the migrations/);
    // Every address outside the fence is one of the two built here.
    const addresses = [...outside.matchAll(/https?:\/\/[^\s)`]+/g)].map((m) => m[0]);
    assert.deepEqual([...new Set(addresses)], ["https://mixos.org/docs/releases/v0.5.0", "https://mixos.org/docs/operating/upgrading"]);
  });

  test("one commit, no migrations, another host, and no notes", () => {
    const body = updateBody(input({ compare: { ahead: 1, behind: 0, commits: 1, files: 1 }, migrations: 0, host: "render", notes: "  \n" }));
    assert.match(body, /1 commit ahead, 0 commits behind, 1 file changed/);
    assert.match(body, /\*\*Platform migrations:\*\* none\./);
    assert.match(body, /Render deploys the merge\. The new version takes traffic once it is healthy\./);
    assert.match(body, /```text\n\(no notes\)\n```/);
  });

  test("the fence outlasts any run of backticks in the notes, and the body stays within GitHub's limit", () => {
    const body = updateBody(input({ notes: "a ``` b\n````\nc" }));
    assert.match(body, /`````text\n/);
    const huge = updateBody(input({ notes: Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n") }));
    assert.ok(huge.length <= MAX_BODY_CHARS);
    assert.match(huge, /\(cut short: \d+ more lines\)/);
  });
});
