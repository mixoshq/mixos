/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The core checkout's block in `.git/info/exclude`: its rules, which `origin`
 * writes it, and that nothing outside it changes. The git tests work in
 * repositories of their own under the system's temporary folder, with an
 * environment of their own, and skip when git isn't available.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BEGIN,
  END,
  coreExcludeRules,
  isCoreOrigin,
  syncCoreExcludes,
  withBlock,
  type GitRunner,
} from "./core-excludes";

/** The rules a checkout of the core had by hand before, in CONTRIBUTING.md. */
const HAND_WRITTEN = [
  "/apps/*",
  "!/apps/AGENTS.md",
  "!/apps/_template/",
  "!/apps/wall-e-345e113c/",
  "/connectors/*",
  "!/connectors/AGENTS.md",
  "!/connectors/_template/",
  "!/connectors/_template-oauth/",
  "/themes/*",
  "!/themes/AGENTS.md",
  "!/themes/_template/",
  "!/themes/mixos-4dea07f5/",
  "!/themes/mixos-dark-d666638f/",
];

describe("the core checkout's exclude block", () => {
  test("its rules are the core's own extensions, kind by kind, as written by hand before", () => {
    assert.deepEqual(coreExcludeRules(), HAND_WRITTEN);
  });

  test("origin is mixoshq/mixos over https or ssh, and nothing else", () => {
    for (const url of [
      "https://github.com/mixoshq/mixos.git",
      "https://github.com/mixoshq/mixos",
      "https://github.com/mixoshq/mixos/",
      "https://github.com/MixOSHQ/MixOS.git",
      "https://x-access-token:abc@github.com/mixoshq/mixos",
      "git@github.com:mixoshq/mixos.git",
      "git@github.com:mixoshq/mixos",
      "ssh://git@github.com/mixoshq/mixos.git",
      "ssh://git@ssh.github.com:443/mixoshq/mixos.git",
      "  https://github.com/mixoshq/mixos.git\n",
    ]) {
      assert.equal(isCoreOrigin(url), true, url);
    }
    for (const url of [
      null,
      "",
      "https://github.com/acme/mixos.git",
      "git@github.com:acme/mixos.git",
      "https://github.com/mixoshq/mixos-org.git",
      "https://github.com/mixoshq/mixos.git.bak",
      "https://gitlab.com/mixoshq/mixos.git",
      "https://github.com.example.com/mixoshq/mixos.git",
      "https://example.com/github.com/mixoshq/mixos.git",
      "/srv/git/mixoshq/mixos.git",
      "file:///srv/github.com/mixoshq/mixos.git",
    ]) {
      assert.equal(isCoreOrigin(url), false, String(url));
    }
  });

  const rules = coreExcludeRules();
  const block = [BEGIN, ...rules, END].join("\n");
  const theirs = "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n*.local-notes\n";

  test("added at the end, with every other line as it was", () => {
    assert.equal(withBlock(theirs, rules), `${theirs}${block}\n`);
    assert.equal(withBlock("", rules), `${block}\n`);
    assert.equal(withBlock("no newline at the end", rules), `no newline at the end\n${block}\n`);
  });

  test("replaced where it is, and removed leaving the lines around it", () => {
    const old = `first\n${BEGIN_LINE_OF_AN_OLDER_VERSION}\n/apps/*\n${END}\nlast\n\n`;
    assert.equal(withBlock(old, rules), `first\n${block}\nlast\n\n`);
    assert.equal(withBlock(old, null), "first\nlast\n\n");
    assert.equal(withBlock(`${theirs}${block}\n`, null), theirs);
    assert.equal(withBlock(theirs, null), theirs);
    assert.equal(withBlock(`${block}\n`, null), "");
  });

  test("a second run changes nothing", () => {
    for (const text of ["", theirs, `a\n${block}\nb\n`]) {
      for (const r of [rules, null]) {
        const once = withBlock(text, r)!;
        assert.equal(withBlock(once, r), once);
      }
    }
  });

  test("two blocks become one, where the first was", () => {
    assert.equal(withBlock(`a\n${block}\nb\n${block}\nc\n`, rules), `a\n${block}\nb\nc\n`);
  });

  test("a block with no end is left for a person, not guessed at", () => {
    assert.equal(withBlock(`a\n${BEGIN}\n/apps/*\nb\n`, rules), null);
    assert.equal(withBlock(`a\n${BEGIN}\n`, null), null);
  });
});

/** A BEGIN line as a later version might word it: the mark is what's matched. */
const BEGIN_LINE_OF_AN_OLDER_VERSION = "# BEGIN MixOS core checkout (an earlier wording)";

describe("in a git repository", () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  let git: (cwd: string, ...args: string[]) => ReturnType<typeof spawnSync>;
  let runner: GitRunner;
  let available = true;

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mixos-core-excludes-")));
    env = {
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      // Never a repository above the test's own folder.
      GIT_CEILING_DIRECTORIES: path.dirname(tmp),
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    } as unknown as NodeJS.ProcessEnv;
    git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env });
    runner = (cwd, args) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
      return r.error || r.status !== 0 ? null : String(r.stdout).trim();
    };
    available = spawnSync("git", ["--version"], { env }).status === 0;
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** A new repository at `tmp/<name>`, with an extension of its own and the core's template on disk. */
  function repo(name: string, origin: string | null): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    assert.equal(git(dir, "init", "-q", "-b", "main").status, 0);
    if (origin) git(dir, "remote", "add", "origin", origin);
    for (const file of ["apps/AGENTS.md", "apps/_template/app.json", "apps/myapp/app.json", "themes/mixos/theme.json", "themes/our-brand/theme.json"]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), `${file}\n`);
    }
    return dir;
  }
  const exclude = (dir: string) => path.join(dir, ".git", "info", "exclude");
  const ignored = (dir: string, file: string) => git(dir, "check-ignore", "-q", file).status === 0;

  test("origin mixoshq/mixos: the block is written, and the core's own stay visible", (t) => {
    if (!available) return t.skip("git isn't available");
    const dir = repo("core", "https://github.com/mixoshq/mixos.git");
    const before = fs.readFileSync(exclude(dir), "utf8");
    const result = syncCoreExcludes(dir, runner);
    assert.deepEqual(result, { action: "written", file: exclude(dir) });
    assert.equal(fs.readFileSync(exclude(dir), "utf8"), `${before}${[BEGIN, ...coreExcludeRules(), END].join("\n")}\n`);
    assert.equal(ignored(dir, "apps/myapp/app.json"), true);
    assert.equal(ignored(dir, "themes/our-brand/theme.json"), true);
    assert.equal(ignored(dir, "apps/_template/app.json"), false);
    assert.equal(ignored(dir, "apps/AGENTS.md"), false);
    assert.equal(ignored(dir, "themes/mixos-4dea07f5/theme.json"), false);
    assert.doesNotMatch(String(git(dir, "status", "--porcelain", "--untracked-files=all").stdout), /myapp|our-brand/);

    // A second run changes nothing, not even the file's time.
    const mtime = fs.statSync(exclude(dir)).mtimeMs;
    assert.deepEqual(syncCoreExcludes(dir, runner), { action: "unchanged", file: exclude(dir) });
    assert.equal(fs.statSync(exclude(dir)).mtimeMs, mtime);
  });

  test("another origin, or none: the block goes, the lines around it stay, and their own folders show", (t) => {
    if (!available) return t.skip("git isn't available");
    const dir = repo("copy", "git@github.com:mixoshq/mixos.git");
    fs.appendFileSync(exclude(dir), "*.local-notes\n");
    const before = fs.readFileSync(exclude(dir), "utf8");
    assert.equal(syncCoreExcludes(dir, runner).action, "written");
    fs.appendFileSync(exclude(dir), "after-the-block\n");

    // `/mixos init` renames origin to upstream, then this runs.
    git(dir, "remote", "rename", "origin", "upstream");
    assert.equal(syncCoreExcludes(dir, runner).action, "removed");
    assert.equal(fs.readFileSync(exclude(dir), "utf8"), `${before}after-the-block\n`);
    assert.equal(ignored(dir, "apps/myapp/app.json"), false);
    assert.match(String(git(dir, "status", "--porcelain", "--untracked-files=all").stdout), /^\?\? apps\/myapp\/app\.json$/m);
    assert.equal(syncCoreExcludes(dir, runner).action, "unchanged");

    // Their own repository as origin: still none.
    git(dir, "remote", "add", "origin", "https://github.com/acme/mixos.git");
    assert.equal(syncCoreExcludes(dir, runner).action, "unchanged");
    assert.equal(fs.readFileSync(exclude(dir), "utf8"), `${before}after-the-block\n`);
  });

  test("no repository, or not its top, or no git: nothing happens", (t) => {
    if (!available) return t.skip("git isn't available");
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    assert.equal(syncCoreExcludes(plain, runner).action, "skipped");
    assert.equal(fs.existsSync(path.join(plain, ".git")), false);

    const dir = repo("nested", "https://github.com/mixoshq/mixos.git");
    const before = fs.readFileSync(exclude(dir), "utf8");
    assert.equal(syncCoreExcludes(path.join(dir, "apps"), runner).action, "skipped");
    assert.equal(syncCoreExcludes(dir, () => null).action, "skipped");
    assert.equal(fs.readFileSync(exclude(dir), "utf8"), before);
  });

  test("a worktree shares the block, in the common git dir", (t) => {
    if (!available) return t.skip("git isn't available");
    const dir = repo("with-worktree", "https://github.com/mixoshq/mixos.git");
    git(dir, "add", "apps/AGENTS.md");
    git(dir, "commit", "-q", "-m", "init");
    const wt = path.join(tmp, "the-worktree");
    assert.equal(git(dir, "worktree", "add", "-q", "-b", "side", wt).status, 0);
    fs.mkdirSync(path.join(wt, "apps", "myapp"), { recursive: true });
    fs.writeFileSync(path.join(wt, "apps", "myapp", "app.json"), "{}\n");
    assert.deepEqual(syncCoreExcludes(wt, runner), { action: "written", file: exclude(dir) });
    assert.equal(ignored(wt, "apps/myapp/app.json"), true);
    assert.equal(ignored(dir, "apps/myapp/app.json"), true);
  });

  test("their own app, committed, comes through a release merged from upstream untouched", (t) => {
    if (!available) return t.skip("git isn't available");
    // MixOS: a release, then a newer one that changes a core file.
    const upstream = repo("upstream-work", null);
    fs.rmSync(path.join(upstream, "apps", "myapp"), { recursive: true });
    fs.rmSync(path.join(upstream, "themes", "our-brand"), { recursive: true });
    fs.writeFileSync(path.join(upstream, "README.md"), "MixOS\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "chore(os): release v0.1.0");
    git(upstream, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
    fs.writeFileSync(path.join(upstream, "README.md"), "MixOS, newer\n");
    git(upstream, "commit", "-q", "-am", "chore(os): release v0.2.0");
    git(upstream, "tag", "-a", "v0.2.0", "-m", "v0.2.0");
    const bare = path.join(tmp, "mixos.git");
    assert.equal(git(tmp, "clone", "-q", "--bare", upstream, bare).status, 0);

    // A clone, at v0.1.0, whose origin is MixOS's: the block hides their app.
    const copy = path.join(tmp, "their-copy");
    assert.equal(git(tmp, "clone", "-q", bare, copy).status, 0);
    // Its origin says GitHub, as a real clone's does; fetching it reads the local copy, and nothing goes online.
    git(copy, "remote", "set-url", "origin", "https://github.com/mixoshq/mixos.git");
    git(copy, "config", `url.${bare}.insteadOf`, "https://github.com/mixoshq/mixos.git");
    git(copy, "config", "protocol.https.allow", "never");
    git(copy, "switch", "-q", "-C", "main", "v0.1.0");
    fs.mkdirSync(path.join(copy, "apps", "myapp"), { recursive: true });
    fs.writeFileSync(path.join(copy, "apps", "myapp", "app.json"), '{ "name": "Mine" }\n');
    assert.equal(syncCoreExcludes(copy, runner).action, "written");
    assert.equal(ignored(copy, "apps/myapp/app.json"), true);

    // `/mixos init`, Step 7: origin becomes upstream, the block goes, and their app can be committed.
    git(copy, "remote", "rename", "origin", "upstream");
    assert.equal(syncCoreExcludes(copy, runner).action, "removed");
    assert.match(String(git(copy, "status", "--porcelain").stdout), /^\?\? apps\/myapp\/$/m);
    git(copy, "add", "apps/myapp");
    assert.equal(git(copy, "commit", "-q", "-m", "feat(myapp): add my app").status, 0);
    const mine = String(git(copy, "rev-parse", "HEAD:apps/myapp").stdout).trim();

    // The next release, merged from upstream.
    assert.equal(git(copy, "fetch", "-q", "upstream", "--tags").status, 0);
    assert.equal(git(copy, "merge", "--no-edit", "v0.2.0").status, 0);
    assert.equal(String(git(copy, "rev-parse", "HEAD:apps/myapp").stdout).trim(), mine);
    assert.equal(fs.readFileSync(path.join(copy, "README.md"), "utf8"), "MixOS, newer\n");
    assert.equal(String(git(copy, "status", "--porcelain").stdout), "");
  });
});
