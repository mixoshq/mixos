/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { InstallRecord } from "@/lib/repository/install-record";
import { runGroups } from "@/lib/repository/review";
import {
  claimLine,
  fenced,
  proposalBody,
  removalProposalBody,
  updateProposalBody,
  type ProposalBodyInput,
  type RemovalBodyInput,
  type UpdateBodyInput,
} from "./pull-body";

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

/* ── an update's body, and a removal's ─────────────────────────────────── */

function updateInput(over: Partial<UpdateBodyInput> = {}): UpdateBodyInput {
  const base = input();
  return {
    record: { ...record, version: "1.3.0", gitTag: "v1.3.0", commitSha: "89abcdef0123456789abcdef0123456789abcdef" },
    from: { version: "1.2.0", commitSha: record.commitSha },
    direction: "newer",
    changes: { changed: ["app.json", "api/items/route.ts"], added: ["assets/logo.png"], removed: ["README.md", "api/[id]/route.ts"], more: { changed: 0, added: 0, removed: 0 }, incomplete: false },
    declarations: [{ label: "Egress", added: ["api.example.com @everyone"], removed: ["old.example.com"] }],
    migrations: { added: ["002_index.sql"], changed: [], lacking: [] },
    compareUrl: "https://github.com/acme/mixos-files/compare/0123456789abcdef0123456789abcdef01234567...89abcdef0123456789abcdef0123456789abcdef",
    leftOut: base.leftOut,
    runs: base.runs,
    floor: base.floor,
    yanked: null,
    claims: base.claims,
    host: "vercel",
    ...over,
  };
}

describe("an update's pull request body", () => {
  test("what changes, what was verified, what runs, and that rollback is reverting the merge", () => {
    const body = updateProposalBody(updateInput());
    assert.match(body, /^Updates the app `files` from 1\.2\.0 to 1\.3\.0 from mixos\.org: the tree replaces `apps\/files\/`\./);
    assert.match(body, /\*\*Files in `apps\/files\/`:\*\* 2 changed, 1 added, 2 deleted\. The diff shows them\./);
    assert.match(body, /\*\*The source's own history, between the two releases:\*\* https:\/\/github\.com\/acme\/mixos-files\/compare\//);
    assert.match(body, /\*\*Manifest:\*\* changes to Egress \(1 added, 1 dropped\)\. The values are with the claims below\./);
    assert.match(body, /\*\*Migrations:\*\* 1 new migration in `1\.3\.0`\. The release step applies them, and they are forward-only: back up the database before you merge\./);
    assert.match(body, /\*\*Release:\*\* `1\.3\.0` \(tag `v1\.3\.0`\), commit `89abcdef[0-9a-f]+`, in place of `1\.2\.0` at commit `0123456789abcdef[0-9a-f]+`\./);
    assert.match(body, /\*\*The folder it replaces\*\* was checked first/);
    assert.match(body, /\*\*MixOS floor:\*\* 0\.2\.0 or newer/);
    assert.match(body, /Vercel builds the merge and puts it into production\. The production build's release step applies the migrations/);
    assert.match(body, /\*\*Then:\*\* its activation, grants, settings and API keys belong to its slug in each database, so they carry over\./);
    assert.match(body, /### Rolling back\n\nRevert the merge and deploy again, or redeploy the previous build on your host\. Neither undoes a migration the new release ran/);
    // The declared values are the publisher's: only in the fence, escaped.
    const outside = outsideFence(body);
    assert.ok(!/@/.test(outside) && !outside.includes("api.example.com"), outside);
    assert.match(body, /^egress adds: api\.example\.com \\@everyone$/m);
    assert.match(body, /^egress drops: old\.example\.com$/m);
    assert.ok(!body.includes("Withdrawn") && !body.includes("older release"));
  });

  test("an older release, one that lacks migrations, a theme, and a withdrawn target", () => {
    const older = updateProposalBody(
      updateInput({
        direction: "older",
        migrations: { added: [], changed: ["001_init.sql"], lacking: ["002_index.sql", "003_more.sql"] },
        yanked: { reason: "Broken @maintainer #99" },
      }),
    );
    assert.match(older, /\*\*An older release\.\*\* An admin chose to go back from `1\.2\.0` to `1\.3\.0`\./);
    assert.match(older, /\*\*Migrations:\*\* 2 migrations in `1\.2\.0` and not in `1\.3\.0`\. A database that ran them stays at the newer schema/);
    assert.match(older, /1 migration changed\. Each runs once/);
    assert.match(older, /\*\*Withdrawn by its publisher\.\*\* An admin proposed it anyway/);
    assert.match(older, /^withdrawn: Broken \\@maintainer \\#99$/m);
    assert.ok(!/@maintainer|#99/.test(outsideFence(older)));
    assert.match(updateProposalBody(updateInput({ direction: "unknown" })), /\*\*Order unknown\.\*\*/);
    assert.match(updateProposalBody(updateInput({ declarations: null })), /\*\*Manifest:\*\* one of the two manifests can't be read/);
    assert.match(updateProposalBody(updateInput({ declarations: [] })), /\*\*Manifest:\*\* no change to what it declares \(egress, env/);
    assert.match(updateProposalBody(updateInput({ migrations: { added: [], changed: [], lacking: [] } })), /\*\*Migrations:\*\* no change\./);
    const theme = updateProposalBody(
      updateInput({ record: { ...record, kind: "theme", version: "1.3.0" }, runs: null, declarations: [], migrations: { added: [], changed: [], lacking: [] } }),
    );
    assert.match(theme, /\*\*Manifest:\*\* a theme declares nothing that runs\./);
    assert.match(theme, /\*\*Code:\*\* none\. A theme is CSS and assets\./);
    assert.match(theme, /\*\*Then:\*\* an instance that applies it keeps applying it\./);
    assert.ok(!theme.includes("Migrations"));
    assert.match(theme, /### Rolling back\n\nRevert the merge and deploy again, or redeploy the previous build on your host\.\n/);
    assert.match(updateProposalBody(updateInput({ host: "image" })), /With Docker Compose, pull it on the server/);
  });
});

describe("a removal's pull request body", () => {
  const removal = (over: Partial<RemovalBodyInput> = {}): RemovalBodyInput => ({
    record,
    fileCount: 7,
    warnings: [],
    claims: { name: HOSTILE },
    host: "render",
    ...over,
  });

  test("what goes, what stays on each instance, the way back, and the name only in the fence", () => {
    const body = removalProposalBody(removal());
    assert.match(body, /^Removes the app `files`: the tree deletes `apps\/files\/`\. An admin proposed it from MixOS, through the GitHub App\./);
    assert.match(body, /\*\*The folder:\*\* `apps\/files\/`, 7 files, `\.registry\.json` included\./);
    assert.match(body, /\*\*What it held:\*\* release `1\.2\.0` \(tag `v1\.2\.0`\) from mixos\.org, commit `0123456789abcdef[0-9a-f]+`, content hash `sha256-A{43}=`, files hash `sha256-B{43}=`\./);
    assert.match(body, /- Each instance keeps the app's data until an admin deletes it there\. After the merge deploys, Admin > Apps lists it under Not in this build, with Delete data\./);
    assert.match(body, /Render deploys the merge\. The new version takes traffic once it is healthy\. The release step marks it missing and deletes nothing\./);
    assert.match(body, /### Rolling back\n\nRevert the merge and deploy again, or redeploy the previous build on your host\. Nothing was deleted from any database/);
    const outside = outsideFence(body);
    assert.ok(!/@|#\d|evil|everyone/.test(outside), outside);
    assert.match(body, /^name: Files \\@everyone fixes \\#12 \\\[click\\\]\(https:\/\/evil\.example\)/m);
  });

  test("warnings in this instance's words, naming apps by slug; a connector's and a theme's data lines", () => {
    const connector = removalProposalBody(
      removal({
        record: { ...record, kind: "connector" },
        warnings: [{ code: "optional-for", message: "Optional for Notes @everyone (apps/notes)", apps: [{ slug: "notes", name: "Notes @everyone" }] }],
      }),
    );
    assert.match(connector, /\*\*Optional for\*\* `apps\/notes`: the parts that use it stop working, and the rest keeps working\./);
    assert.ok(!outsideFence(connector).includes("@everyone"));
    assert.match(connector, /Each instance keeps the connector's credentials until an admin deletes them there\. After the merge deploys, Admin > Connectors lists it/);
    const theme = removalProposalBody(
      removal({
        record: { ...record, kind: "theme" },
        warnings: [{ code: "applied-theme", message: "It is the applied theme", apps: [] }],
      }),
    );
    assert.match(theme, /\*\*The applied theme\.\*\* An instance that applies it shows the first theme by name once the removal is deployed there/);
    assert.match(theme, /- A theme holds no data\.\n/);
    assert.ok(!theme.includes("Delete data"));
  });
});
