/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { InstallRecord } from "@/lib/repository/install-record";
import { runGroups } from "@/lib/repository/review";
import { claimLine, fenced, proposalBody, type ProposalBodyInput } from "./pull-body";

const record: InstallRecord = {
  source: "https://mixos.org",
  kind: "app",
  slug: "files",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  contentHash: `sha256-${"A".repeat(43)}=`,
  filesHash: `sha256-${"B".repeat(43)}=`,
  repository: { owner: "acme", name: "mixos-files", subpath: null },
  requiresMixOS: "0.2.0",
};

const HOSTILE = "Files\n@everyone fixes #12 [click](https://evil.example) ```\n```\n\\@team ‮evil";

function input(over: Partial<ProposalBodyInput> = {}): ProposalBodyInput {
  return {
    record,
    leftOut: { ".gitignore": 1 },
    runs: runGroups("app", ["app.json", "hooks.ts", "api/items/route.ts", "api/[id]/route.ts", "migrations/001_init.sql"]),
    migrations: 1,
    floor: { declared: "0.2.0", current: "0.3.1", where: "deployment", met: true, checked: true, reason: null },
    yanked: null,
    claims: {
      name: HOSTILE,
      publisher: "@acme-bot",
      permissions: [{ scope: "network:api.example.com", reason: "Closes #3, cc @org/team" }],
    },
    host: "vercel",
    ...over,
  };
}

/** The body outside its fenced block. */
function outsideFence(body: string): string {
  return body.replace(/(`{3,})text\n[\s\S]*?\n\1(?=\n|$)/g, "");
}

describe("a proposal's pull request body", () => {
  test("a claim is one line, escaped, and capped", () => {
    assert.equal(claimLine("name", "a\nb@everyone #1 [x](y) \\"), "name: a b\\@everyone \\#1 \\[x\\](y) \\\\");
    assert.equal(claimLine("name", "‮right​to⁦left"), "name: right to left");
    assert.equal(claimLine("name", "x".repeat(400)).length, "name: ".length + 300);
    assert.equal(claimLine("name", "\n\n"), "name: (empty)");
  });

  test("the fence is longer than any run of backticks inside it", () => {
    const block = fenced(["a ``` b", "c ````` d"]);
    assert.ok(block.startsWith("``````text\n"));
    assert.ok(block.endsWith("\n``````"));
    assert.ok(fenced(["plain"]).startsWith("```text\n"));
  });

  test("what was verified, what runs and when, the floor, and what merging does", () => {
    const body = proposalBody(input());
    assert.match(body, /^Adds the app `files` 1\.2\.0 from mixos\.org\./);
    assert.match(body, /commit `0123456789abcdef0123456789abcdef01234567`/);
    assert.match(body, /\*\*Content hash:\*\* `sha256-A{43}=`/);
    assert.match(body, /\*\*Files hash:\*\* `sha256-B{43}=`, over the files in `apps\/files\/`/);
    assert.match(body, /https:\/\/github\.com\/acme\/mixos-files\/tree\/0123456789abcdef0123456789abcdef01234567/);
    assert.match(body, /\*\*MixOS floor:\*\* 0\.2\.0 or newer\. The instance that proposed it runs 0\.3\.1, which meets it\./);
    assert.match(body, /Left out \.gitignore \(1 file\)/);
    assert.match(body, /Vercel builds the merge and puts it into production\. The production build's release step applies the migrations/);
    assert.match(body, /arrives inactive\. Activate it on Admin > Apps\./);
    assert.match(body, /`hooks\.ts` \(1 file\), `api\/` \(2 files\), `migrations\/\*\.sql` \(1 file\)/);
    assert.match(body, /Back up the database before you merge/);
    assert.ok(!body.includes("Withdrawn"));

    assert.match(proposalBody(input({ host: "render", migrations: 0 })), /Render deploys the merge\. The new version takes traffic/);
    assert.match(proposalBody(input({ host: "railway" })), /Railway deploys the merge\. Its release step applies the migrations first\./);
    assert.match(proposalBody(input({ host: "image" })), /With Docker Compose, pull it on the server/);
    const theme = proposalBody(input({ record: { ...record, kind: "theme" }, runs: null, migrations: 0 }));
    assert.match(theme, /\*\*Code:\*\* none\. A theme is CSS and assets\./);
    assert.ok(!theme.includes("Admin > Apps"));
  });

  test("the publisher's words appear only in the fenced block, escaped", () => {
    const body = proposalBody(
      input({
        yanked: { reason: "Broken. See @maintainer and #99\n```" },
        floor: { declared: "@everyone", current: "0.3.1", where: "deployment", met: true, checked: false, reason: null },
      }),
    );
    const outside = outsideFence(body);
    assert.ok(!/@/.test(outside), outside);
    assert.ok(!/#\d/.test(outside), outside);
    assert.ok(!/\[[^\]]*\]\(/.test(outside), "no link outside the fence");
    assert.ok(!outside.includes("everyone") && !outside.includes("evil") && !outside.includes("maintainer"));
    assert.match(outside, /Withdrawn by its publisher\./);
    assert.match(outside, /declared, but not as a version/);

    const block = /(`{3,})text\n([\s\S]*?)\n\1/.exec(body);
    assert.ok(block);
    const lines = block![2].split("\n");
    assert.deepEqual(
      lines.map((l) => l.split(":")[0]),
      ["name", "publisher", "permission", "requires MixOS", "withdrawn"],
    );
    for (const line of lines) {
      assert.ok(!/(?<!\\)[@#[\]]/.test(line.replace(/\\\\/g, "")), line);
    }
    assert.ok(lines[0].includes("\\@everyone fixes \\#12 \\[click\\](https://evil.example)"));
    assert.ok(block![1].length > 3, "longer than the ``` in the claims");
  });
});
