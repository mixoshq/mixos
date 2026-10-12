/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hand-back after Register: a commit message built from the install
 * record's identifiers alone, which can never turn a repository's workflows
 * off, the commands that commit it, and what the CLI prints. A test runs the
 * commands in a scratch repository and reads the commit back.
 *
 * And the hand-back after removing an extension's code: the commit that
 * deletes the folder, built from the kind, the name and, for an install, the
 * record's version and source; run the same way.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesHash } from "./content-hash";
import {
  branchName,
  ciSkipMarker,
  commandsFor,
  commitMessage,
  commitSubject,
  formatSize,
  handBackFor,
  handBackLines,
  removalBranchName,
  removalCommitMessage,
  removalHandBackFor,
  removalHandBackLines,
  removalSubject,
  shellWord,
} from "./hand-back";
import { InstallRecordSchema, type InstallRecord } from "./install-record";

const HASH = filesHash([{ path: "app.json", mode: 0o644, data: Buffer.from("{}\n") }]);
const SHA = "9f2be41a3c1d".padEnd(40, "7");

const RECORD: InstallRecord = {
  source: "https://mixos.org",
  kind: "app",
  slug: "files",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: SHA,
  contentHash: HASH,
  filesHash: HASH,
  repository: { owner: "acme", name: "mixos-files", subpath: null },
  requiresMixOS: null,
};

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-hand-back-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the commit message", () => {
  test("its subject is built from the kind, the slug, the version and the catalogue's host", () => {
    assert.equal(commitSubject(RECORD), "feat(files): add app files 1.2.0 from mixos.org");
    assert.equal(
      commitSubject({ ...RECORD, kind: "connector", slug: "acme-crm", version: "9f2be41", source: "http://127.0.0.1:4388" }),
      "feat(acme-crm): add connector acme-crm 9f2be41 from 127.0.0.1:4388",
    );
  });

  test("its trailers are the record's, last, one per line", () => {
    const message = commitMessage(RECORD, "apps/files");
    const paragraphs = message.split("\n\n");
    assert.equal(paragraphs[0], "feat(files): add app files 1.2.0 from mixos.org");
    assert.deepEqual(paragraphs.at(-1)!.split("\n"), [
      "Registry-Source: https://mixos.org",
      "Registry-Version: 1.2.0",
      `Registry-Commit: ${SHA}`,
      `Registry-Content-Hash: ${HASH}`,
      `Registry-Files-Hash: ${HASH}`,
      "Registry-Listing: https://mixos.org/extend/apps/files",
    ]);
    assert.match(message, /apps\/files\/\.registry\.json records the release/);
    assert.match(message, new RegExp(`The source at that commit: https://github\\.com/acme/mixos-files/tree/${SHA}`));
    // The subject and the prose wrap at 72 columns; a URL or a trailer can't wrap.
    for (const line of paragraphs.slice(0, -1).join("\n").split("\n").filter((l) => !l.includes("://"))) {
      assert.ok(line.length <= 72, line);
    }
  });

  test("it never holds anything that turns a repository's workflows off, whatever the record holds", () => {
    const versions = ["1.2.0", "0.0.1-rc.1+build.7", "10.20.30", "9f2be41", SHA];
    const slugs = ["files", "skip-ci", "ci-skip", "no-ci", "skip-actions", "skip-checks", "a1"];
    const sources = ["https://mixos.org", "http://localhost:4321", "http://[::1]:8791", "https://skip-ci.example"];
    const owners = ["acme", "skip-ci", "no-ci"];
    let built = 0;
    for (const version of versions)
      for (const slug of slugs)
        for (const source of sources)
          for (const owner of owners)
            for (const kind of ["app", "connector", "theme"] as const) {
              const record = InstallRecordSchema.parse({
                ...RECORD,
                kind,
                slug,
                version,
                source,
                gitTag: `${slug}@v1`,
                repository: { owner, name: `${slug}.skip`, subpath: `skip/ci/${slug}` },
              });
              const message = commitMessage(record, `${kind}s/${slug}`);
              assert.equal(ciSkipMarker(message), null, message);
              built++;
            }
    assert.equal(built, versions.length * slugs.length * sources.length * owners.length * 3);
  });

  test("the record's schema refuses what a manifest's name could carry", () => {
    for (const fields of [
      { version: "1.2.0 [skip ci]" },
      { version: "[ci skip]" },
      { slug: "[no ci]" },
      { gitTag: "[skip actions]" },
      { source: "https://[actions skip]" },
      { repository: { owner: "acme", name: "board", subpath: "[skip ci]" } },
      { version: "1.2.0\n\nskip-checks: true" },
    ]) {
      assert.equal(InstallRecordSchema.safeParse({ ...RECORD, ...fields }).success, false, JSON.stringify(fields));
    }
  });

  test("ciSkipMarker finds each of GitHub's markers, in any case and spacing", () => {
    for (const text of [
      "Add it [skip ci]",
      "[ci skip] add it",
      "add [No CI]",
      "add [skip actions]",
      "add [ACTIONS SKIP]",
      "add [ skip  ci ]",
      "add it\n\nskip-checks: true",
      "add it\n\nSkip-Checks:true",
    ]) {
      assert.ok(ciSkipMarker(text), text);
    }
    assert.equal(ciSkipMarker("skip ci without brackets, and skip-checks in prose"), null);
  });
});

describe("the commands", () => {
  test("commit the folder alone on a branch of its own, with the message from a quoted here-document", () => {
    const handBack = handBackFor(RECORD, "apps/files", [{ path: "app.json", bytes: 3 }]);
    assert.equal(branchName(RECORD), "add-app-files");
    assert.deepEqual(handBack.commands.split("\n").filter((l) => l.startsWith("git ")), [
      "git switch -c add-app-files",
      "git add apps/files",
      "git commit -F - -- apps/files <<'MSG'",
      "git push -u origin HEAD",
    ]);
    assert.ok(handBack.commands.includes(`<<'MSG'\n${handBack.commitMessage}\nMSG\n`));
  });

  test("a file .gitignore would leave out is added by name, quoted for the shell", () => {
    const commands = commandsFor(
      { branch: "add-app-files", folder: "apps/files", commitMessage: "m" },
      ["apps/files/cert.pem", "apps/files/$(touch pwned) it's.pem"],
    );
    assert.match(commands, /^git add -f apps\/files\/cert\.pem 'apps\/files\/\$\(touch pwned\) it'\\''s\.pem'$/m);
    assert.equal(shellWord("apps/files/a b"), "'apps/files/a b'");
    assert.equal(shellWord("apps/files/README.md"), "apps/files/README.md");
  });

  test("run in a repository, they commit the folder alone with the message and its trailers", (t) => {
    // Only what git needs, and no user's own configuration.
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    } as unknown as NodeJS.ProcessEnv;
    const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env });
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    if (git(repo, "init", "-q", "-b", "main").status !== 0) {
      t.skip("git isn't available");
      return;
    }
    fs.writeFileSync(path.join(repo, "README.md"), "# A fork\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
    // Other work, staged, which the commit must leave alone.
    fs.writeFileSync(path.join(repo, "other.txt"), "staged, not ours\n");
    git(repo, "add", "other.txt");
    fs.mkdirSync(path.join(repo, "apps", "files"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "files", "app.json"), "{}\n");
    fs.writeFileSync(path.join(repo, "apps", "files", ".registry.json"), "{}\n");

    const handBack = handBackFor(RECORD, "apps/files", [{ path: "app.json", bytes: 3 }]);
    const script = handBack.commands.replace(/\ngit push -u origin HEAD$/, "\n");
    const run = spawnSync("bash", ["-e", "-c", script], { cwd: repo, encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);

    assert.equal(git(repo, "branch", "--show-current").stdout.trim(), "add-app-files");
    assert.equal(git(repo, "log", "-1", "--format=%B").stdout.trim(), handBack.commitMessage);
    assert.equal(
      git(repo, "log", "-1", "--format=%(trailers:key=Registry-Source,valueonly)").stdout.trim(),
      "https://mixos.org",
    );
    assert.deepEqual(git(repo, "show", "--name-only", "--format=", "HEAD").stdout.trim().split("\n").sort(), [
      "apps/files/.registry.json",
      "apps/files/app.json",
    ]);
    // Still staged, still not committed.
    assert.equal(git(repo, "diff", "--cached", "--name-only").stdout.trim(), "other.txt");
  });
});

describe("what it hands back", () => {
  test("sizes are written for a person", () => {
    assert.equal(formatSize(612), "612 B");
    assert.equal(formatSize(1024), "1.0 KB");
    assert.equal(formatSize(1260), "1.2 KB");
    assert.equal(formatSize(38 * 1024), "38 KB");
    assert.equal(formatSize(3.4 * 1024 * 1024), "3.4 MB");
  });

  test("the files, at most a hundred by name, with the rest counted, and the source link", () => {
    const files = Array.from({ length: 103 }, (_, i) => ({ path: `assets/${String(i).padStart(3, "0")}.png`, bytes: 1024 }));
    const handBack = handBackFor(
      { ...RECORD, kind: "theme", slug: "dusk", repository: { owner: "acme", name: "themes", subpath: "dusk" } },
      "themes/dusk",
      files,
    );
    assert.equal(handBack.files.length, 100);
    assert.equal(handBack.more, 3);
    assert.equal(handBack.fileCount, 103);
    assert.equal(handBack.totalSize, "103 KB");
    assert.equal(handBack.sourceUrl, `https://github.com/acme/themes/tree/${SHA}/dusk`);
    assert.equal(handBack.listingUrl, "https://mixos.org/extend/themes/dusk");
    assert.equal(handBack.host, "mixos.org");
  });

  test("for a terminal: the files, a warning for what git would leave out, and the commands, unindented", () => {
    const handBack = handBackFor(RECORD, "apps/files", [
      { path: ".registry.json", bytes: 612 },
      { path: "app.json", bytes: 1260 },
      { path: "cert.pem", bytes: 900 },
    ]);
    const lines = handBackLines(handBack, {
      isApp: true,
      ignored: [{ path: "apps/files/cert.pem", rule: ".gitignore:22:*.pem" }],
    });
    const text = lines.join("\n");
    assert.match(text, /Files added in apps\/files\/ \(3 files, 2\.7 KB\):\n {4}\.registry\.json {2}612 B\n {4}app\.json {8}1\.2 KB/);
    assert.match(text, /Your \.gitignore leaves this file out of `git add apps\/files`/);
    assert.match(text, /apps\/files\/cert\.pem {2}\(\.gitignore:22:\*\.pem\)/);
    assert.match(text, /^git add apps\/files\ngit add -f apps\/files\/cert\.pem\ngit commit -F - -- apps\/files <<'MSG'\nfeat\(files\)/m);
    assert.match(text, /^MSG\ngit push -u origin HEAD$/m);
    assert.match(text, /Or run \/mixos deploy/);
    assert.match(text, /ships it on Coolify, Dokploy, Render, Railway and Vercel/);
    assert.match(text, /With Docker Compose on your own server, pull it there, then build, migrate and start/);
    assert.match(text, /It arrives inactive on each instance/);
    assert.doesNotMatch(handBackLines(handBack, { isApp: false }).join("\n"), /\.gitignore leaves|arrives inactive/);
  });
});

describe("the removal's commit", () => {
  const INSTALLED = { source: "https://mixos.org", version: "1.2.0" };

  test("its subject is the kind and the name, and for an install the version and the catalogue's host", () => {
    assert.equal(removalSubject({ kind: "app", slug: "files", installed: null }), "feat(files): remove app files");
    assert.equal(
      removalSubject({ kind: "theme", slug: "dusk", installed: INSTALLED }),
      "feat(dusk): remove theme dusk 1.2.0 from mixos.org",
    );
    assert.equal(removalBranchName({ kind: "connector", slug: "acme-crm" }), "remove-connector-acme-crm");
  });

  test("its body says what stays, and an install's trailers are its source and version alone", () => {
    const local = removalCommitMessage({ kind: "app", slug: "my_app", installed: null }, "apps/my_app");
    const [subject, blank, ...body] = local.split("\n");
    assert.deepEqual([subject, blank], ["feat(my_app): remove app my_app", ""]);
    assert.equal(body.join(" "), "Removed in a checkout. Each instance keeps the app's data until an admin deletes it there.");
    assert.doesNotMatch(local, /Registry-/);
    const installed = removalCommitMessage({ kind: "connector", slug: "probe", installed: INSTALLED }, "connectors/probe");
    assert.deepEqual(installed.split("\n\n").at(-1)!.split("\n"), [
      "Registry-Source: https://mixos.org",
      "Registry-Version: 1.2.0",
    ]);
    const prose = installed.split("\n\n").slice(1, -1).join(" ").replace(/\n/g, " ");
    assert.match(prose, /Its install record, connectors\/probe\/\.registry\.json, goes with it\./);
    assert.match(prose, /Each instance keeps the connector's credentials until an admin deletes them there\./);
    assert.match(
      removalCommitMessage({ kind: "theme", slug: "dusk", installed: null }, "themes/dusk"),
      /\n\nRemoved in a checkout\. A theme holds no data\.$/,
    );
    for (const line of installed.split("\n").filter((l) => !l.includes("://"))) assert.ok(line.length <= 72, line);
  });

  test("it never holds anything that turns a repository's workflows off, and refuses a name that isn't one", () => {
    for (const slug of ["skip-ci", "ci-skip", "no-ci", "skip_actions", "skip-checks", "a1"]) {
      for (const kind of ["app", "connector", "theme"] as const) {
        for (const installed of [null, INSTALLED, { source: "http://localhost:4321", version: "9f2be41" }]) {
          const message = removalCommitMessage({ kind, slug, installed }, `${kind}s/${slug}`);
          assert.equal(ciSkipMarker(message), null, message);
        }
      }
    }
    for (const slug of ["[skip ci]", "files [no ci]", "a\n\nskip-checks: true", "../x", "Files", ""]) {
      assert.throws(() => removalCommitMessage({ kind: "app", slug, installed: null }, "apps/x"), /not the name/, slug);
    }
  });

  test("for a terminal: the files deleted, and the commands unindented", () => {
    const handBack = removalHandBackFor({ kind: "app", slug: "files", installed: INSTALLED }, "apps/files", [
      { path: ".registry.json", bytes: 612 },
      { path: "app.json", bytes: 1260 },
    ]);
    assert.equal(handBack.installedFrom, "mixos.org");
    const text = removalHandBackLines(handBack, { tracked: true }).join("\n");
    assert.match(text, /It is gone from this checkout only\. Commit the deletion of apps\/files and deploy/);
    assert.match(text, /Files deleted from apps\/files\/ \(2 files, 1\.8 KB\):\n {4}\.registry\.json {2}612 B\n {4}app\.json {8}1\.2 KB/);
    assert.match(text, /^git switch -c remove-app-files\ngit rm -r apps\/files\ngit commit -F - -- apps\/files <<'MSG'\nfeat\(files\): remove app files 1\.2\.0 from mixos\.org$/m);
    assert.match(text, /^MSG\ngit push -u origin HEAD$/m);
    assert.match(text, /Or run \/mixos deploy/);
    assert.match(text, /then build, migrate and start, as in docs\/hosting\/docker-compose\.md#upgrading\.$/);
    // Never committed: nothing to commit, and no commands.
    const untracked = removalHandBackLines(handBack, { tracked: false }).join("\n");
    assert.match(untracked, /Git doesn't track apps\/files: it was never committed, so there is nothing to commit\./);
    assert.doesNotMatch(untracked, /git switch/);
  });

  test("run in a repository, they commit the folder's deletion alone, with the message", (t) => {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    } as unknown as NodeJS.ProcessEnv;
    const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env });
    const repo = path.join(tmp, "removal-repo");
    fs.mkdirSync(repo);
    if (git(repo, "init", "-q", "-b", "main").status !== 0) {
      t.skip("git isn't available");
      return;
    }
    fs.mkdirSync(path.join(repo, "apps", "files"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "files", "app.json"), "{}\n");
    fs.writeFileSync(path.join(repo, "apps", "files", ".registry.json"), "{}\n");
    fs.writeFileSync(path.join(repo, "README.md"), "# A fork\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    // Other work, staged, which the commit must leave alone.
    fs.writeFileSync(path.join(repo, "other.txt"), "staged, not ours\n");
    git(repo, "add", "other.txt");
    // What removal leaves: the folder gone from the disk.
    fs.rmSync(path.join(repo, "apps", "files"), { recursive: true });

    const handBack = removalHandBackFor({ kind: "app", slug: "files", installed: INSTALLED }, "apps/files", [
      { path: ".registry.json", bytes: 3 },
      { path: "app.json", bytes: 3 },
    ]);
    const script = handBack.commands.replace(/\ngit push -u origin HEAD$/, "\n");
    const run = spawnSync("bash", ["-e", "-c", script], { cwd: repo, encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);

    assert.equal(git(repo, "branch", "--show-current").stdout.trim(), "remove-app-files");
    assert.equal(git(repo, "log", "-1", "--format=%B").stdout.trim(), handBack.commitMessage);
    assert.equal(git(repo, "log", "-1", "--format=%(trailers:key=Registry-Version,valueonly)").stdout.trim(), "1.2.0");
    assert.deepEqual(git(repo, "show", "--name-status", "--format=", "HEAD").stdout.trim().split("\n").sort(), [
      "D\tapps/files/.registry.json",
      "D\tapps/files/app.json",
    ]);
    assert.equal(git(repo, "diff", "--cached", "--name-only").stdout.trim(), "other.txt");
  });
});
