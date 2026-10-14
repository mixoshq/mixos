/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/release-prep.ts: the version arithmetic and the notes as pure
 * functions, then whole release cycles in scratch git repositories. Those run
 * git with nothing from this machine's configuration, so a global signing,
 * hooks or default-branch setting can't change what they see.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bumpVersion,
  changelogVersions,
  compareVersions,
  escapeMarkdown,
  formatVersion,
  insertSection,
  isCoreRepository,
  isReleasePR,
  minorBecause,
  notesFor,
  parseVersion,
  planRelease,
  releaseBranch,
  releaseSubject,
  renderSection,
  tagCommands,
  toChange,
  versionChanges,
  writeRelease,
  type Plan,
  type RawCommit,
} from "./release-prep";

process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const who of ["AUTHOR", "COMMITTER"]) {
  process.env[`GIT_${who}_NAME`] = "Release Test";
  process.env[`GIT_${who}_EMAIL`] = "release-test@example.com";
}

const TODAY = "2026-10-10";

const raw = (subject: string, files: string[] = [], body = ""): RawCommit => ({
  sha: "0123456789abcdef0123456789abcdef01234567",
  short: "0123456",
  subject,
  body,
  files,
});

describe("versions", () => {
  test("parse and format round-trip, with or without the v", () => {
    for (const v of ["0.1.0", "0.10.3", "1.2.3", "0.2.0-rc.1", "0.2.0-beta.12"]) {
      assert.equal(formatVersion(parseVersion(v)!), v);
      assert.equal(formatVersion(parseVersion(`v${v}`)!), v);
    }
  });

  test("anything but X.Y.Z or X.Y.Z-id.N is refused", () => {
    for (const v of ["0.1", "01.2.3", "0.2.0-rc-1", "0.2.0+build", "0.2.0-", "latest", "v"]) {
      assert.equal(parseVersion(v), null, v);
    }
  });

  test("order follows semver precedence", () => {
    const ordered = ["0.1.0", "0.2.0-beta.1", "0.2.0-rc.1", "0.2.0-rc.2", "0.2.0-rc.10", "0.2.0", "0.2.1", "0.10.0"];
    for (let i = 1; i < ordered.length; i++) {
      const [a, b] = [parseVersion(ordered[i - 1])!, parseVersion(ordered[i])!];
      assert.equal(compareVersions(a, b), -1, `${ordered[i - 1]} < ${ordered[i]}`);
      assert.equal(compareVersions(b, a), 1, `${ordered[i]} > ${ordered[i - 1]}`);
    }
    assert.equal(compareVersions(parseVersion("0.2.0")!, parseVersion("v0.2.0")!), 0);
  });

  test("0.x bumps the minor or the patch, and 1.x has no rule yet", () => {
    assert.equal(formatVersion(bumpVersion(parseVersion("0.3.2")!, "minor")), "0.4.0");
    assert.equal(formatVersion(bumpVersion(parseVersion("0.3.2")!, "patch")), "0.3.3");
    assert.throws(() => bumpVersion(parseVersion("1.0.0")!, "patch"), /0\.x only/);
  });
});

describe("reading a commit", () => {
  test("a breaking footer is the release note, and stops at the trailers", () => {
    const c = toChange(
      raw(
        "feat(os)!: a schema and role per app",
        ["src/lib/apps/app-identifiers.ts"],
        "Why it changed.\n\nBREAKING CHANGE: an app that ships migrations/ must set\n" +
          '"database": true.\n\nCo-Authored-By: Someone <someone@example.com>\n',
      ),
    );
    assert.deepEqual(
      [c.type, c.scopes, c.summary, c.breaking, c.note],
      ["feat", ["os"], "a schema and role per app", true, 'an app that ships migrations/ must set\n"database": true.'],
    );
  });

  test("a footer alone makes a commit breaking, and a trailer right after it ends the note", () => {
    const body = "BREAKING CHANGE: a theme fails the build.\nSigned-off-by: A <a@example.com>";
    const c = toChange(raw("fix(os): tighten a rule", [], body));
    assert.equal(c.breaking, true);
    assert.equal(c.note, "a theme fails the build.");
  });

  test("an app-only commit is a patch; platform files make it a minor whatever its scope", () => {
    assert.equal(minorBecause(toChange(raw("fix(wall-e): a quote", ["apps/wall-e/quotes.ts"]))), null);
    assert.equal(minorBecause(toChange(raw("docs(os): a typo", ["README.md"]))), "scoped os");
    assert.equal(
      minorBecause(toChange(raw("fix(wall-e): a quote", ["apps/wall-e/quotes.ts", "src/lib/x.ts"]))),
      "changes src/lib/x.ts",
    );
    assert.equal(minorBecause(toChange(raw("feat(deals): a plan", ["docs/plans/20261010_0000-deals.md"]))), null);
  });

  test("a subject that isn't a Conventional Commit is kept whole", () => {
    const c = toChange(raw("welcome tour", ["src/components/tour.tsx"]));
    assert.deepEqual([c.type, c.scopes, c.summary], [null, [], "welcome tour"]);
  });
});

describe("the notes", () => {
  test("a subject can't add a link, an image or HTML; a code span is left as written", () => {
    assert.equal(
      escapeMarkdown("[apply the patch](https://evil.example/x)"),
      "\\[apply the patch\\](https://evil.example/x)",
    );
    assert.equal(escapeMarkdown("![](https://evil.example/pixel.png)"), "!\\[\\](https://evil.example/pixel.png)");
    assert.equal(escapeMarkdown("app_<slug>.<name> <img src=x>"), "app_\\<slug\\>.\\<name\\> \\<img src=x\\>");
    assert.equal(escapeMarkdown("read `<slug>` and `a[0]`, not <slug>"), "read `<slug>` and `a[0]`, not \\<slug\\>");
  });

  const changes = [
    toChange({ ...raw("fix(os): restore the colour fence", ["eslint.config.mjs"]), short: "1111111" }),
    toChange({ ...raw("docs(os): what's new", ["WHATS-NEW.md"]), short: "2222222" }),
    toChange({ ...raw("feat(wall-e): rotate the quote hourly", ["apps/wall-e/x.ts"]), short: "3333333" }),
    toChange({
      ...raw("feat(os)!: one schema per app", ["src/x.ts"], "BREAKING CHANGE: app tables are app_<slug>.<name>.\n"),
      short: "4444444",
    }),
    toChange({ ...raw("welcome tour", ["src/y.tsx"]), short: "5555555" }),
    toChange({ ...raw("ops(os): pin Node 24", [".nvmrc"]), short: "6666666" }),
  ];

  test("breaking changes first with their footers, then by type; docs left out", () => {
    const section = renderSection({ version: "0.2.0", date: TODAY, since: "v0.1.0", changes });
    assert.equal(
      section,
      [
        "## v0.2.0 (2026-10-10)",
        "",
        "Changes since v0.1.0. The larger ones are described in [WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.2.0/WHATS-NEW.md).",
        "",
        "### Breaking changes",
        "",
        "- **os:** one schema per app (4444444)",
        "",
        "  App tables are app_\\<slug\\>.\\<name\\>.",
        "",
        "### Features",
        "",
        "- **wall-e:** rotate the quote hourly (3333333)",
        "",
        "### Fixes",
        "",
        "- **os:** restore the colour fence (1111111)",
        "",
        "### Operations",
        "",
        "- **os:** pin Node 24 (6666666)",
        "",
        "### Other changes",
        "",
        "- welcome tour (5555555)",
      ].join("\n"),
    );
  });

  test("a release of only documentation says so, and the first release lists nothing", () => {
    const docs = renderSection({ version: "0.2.1", date: TODAY, since: "v0.2.0", changes: [changes[1]] });
    assert.match(docs, /\n\nDocumentation, tests and internal changes only\.$/);
    const first = renderSection({ version: "0.1.0", date: TODAY, since: null, changes });
    assert.equal(
      first,
      "## v0.1.0 (2026-10-10)\n\nThe first tagged release of MixOS. What changed on the way here is in " +
        "[WHATS-NEW.md](https://github.com/mixoshq/mixos/blob/v0.1.0/WHATS-NEW.md).",
    );
  });

  test("sections go newest first under the header, and the notes are a section without its heading", () => {
    const one = renderSection({ version: "0.1.0", date: TODAY, since: null, changes: [] });
    const two = renderSection({ version: "0.2.0", date: TODAY, since: "v0.1.0", changes: changes.slice(0, 1) });
    const changelog = insertSection(insertSection(null, one), two);
    assert.match(changelog, /^# Changelog\n/);
    assert.deepEqual(changelogVersions(changelog), ["0.2.0", "0.1.0"]);
    assert.equal(notesFor(changelog, "0.2.0"), two.split("\n").slice(2).join("\n"));
    assert.equal(notesFor(changelog, "0.1.0"), one.split("\n").slice(2).join("\n"));
    assert.equal(notesFor(changelog, "0.3.0"), null);
    assert.ok(changelog.endsWith("\n") && !changelog.endsWith("\n\n"));
  });
});

// ── Whole cycles, in scratch repositories ───────────────────────────────────

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-release-prep-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let repos = 0;

const npmJson = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;

function repository(version = "0.1.0") {
  const root = path.join(scratch, `repo-${repos++}`);
  fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const commit = (subject: string, files: string[] = [], body?: string) => {
    for (const file of files) write(file, `${subject}\n`);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", subject, ...(body ? ["-m", body] : []));
    return git("rev-parse", "HEAD");
  };
  const tag = (name: string, rev = "HEAD") => git("tag", "-a", name, "-m", `MixOS ${name}`, rev);
  /** A release PR: --write on a branch, its commit, and a merge commit on main. */
  const releasePR = (v: string, before?: () => void) => {
    git("switch", "-q", "-c", `release/v${v}`);
    writeRelease(root, v, { today: TODAY });
    commit(releaseSubject(v));
    git("switch", "-q", "main");
    before?.();
    git("merge", "-q", "--no-ff", "--no-edit", `release/v${v}`);
    return git("rev-parse", "HEAD");
  };
  const plan = (pre?: string) => planRelease(root, { pre, today: TODAY });

  git("init", "-q", "-b", "main");
  write("package.json", npmJson({ name: "mixos", version, private: true }));
  const lock = { name: "mixos", version, lockfileVersion: 3, packages: { "": { name: "mixos", version } } };
  write("package-lock.json", npmJson(lock));
  commit("genesis", ["src/index.ts"]);
  return { root, git, write, commit, tag, releasePR, plan };
}

function next(plan: Plan) {
  assert.equal(plan.kind, "next", JSON.stringify(plan));
  return plan as Extract<Plan, { kind: "next" }>;
}
function toTag(plan: Plan) {
  assert.equal(plan.kind, "tag", JSON.stringify(plan));
  return plan as Extract<Plan, { kind: "tag" }>;
}

describe("a release cycle", () => {
  test("the first release is package.json's version, and changes only CHANGELOG.md", () => {
    const r = repository();
    r.commit("feat(os): a platform", ["src/a.ts"]);
    const first = next(r.plan());
    assert.deepEqual([first.version, first.bump, first.since], ["0.1.0", "first", null]);
    assert.equal(next(r.plan("rc")).version, "0.1.0-rc.1");

    const before = fs.readFileSync(path.join(r.root, "package.json"), "utf8");
    const merge = r.releasePR("0.1.0");
    assert.equal(fs.readFileSync(path.join(r.root, "package.json"), "utf8"), before);
    assert.deepEqual(r.git("show", "--name-only", "--format=", "HEAD^2").split("\n"), ["CHANGELOG.md"]);

    const tagging = toTag(r.plan());
    assert.deepEqual([tagging.version, tagging.commit, tagging.unlisted], ["0.1.0", merge, []]);
    assert.deepEqual(tagCommands(tagging), [
      `git tag -a v0.1.0 -m "MixOS v0.1.0" ${merge}`,
      "git push origin v0.1.0",
      "npx tsx scripts/release-prep.ts --notes 0.1.0 | gh release create v0.1.0 --verify-tag --title v0.1.0 --notes-file -",
    ]);

    r.tag("v0.1.0", merge);
    assert.deepEqual(r.plan(), { kind: "nothing", since: "v0.1.0" });
  });

  test("an app-only release is a patch; an os commit or a platform file makes it a minor", () => {
    const r = repository();
    r.tag("v0.1.0");
    r.commit("fix(wall-e): a quote", ["apps/wall-e/quotes.ts"]);
    const patch = next(r.plan());
    assert.deepEqual([patch.version, patch.bump, patch.reasons, patch.warnings], ["0.1.1", "patch", [], []]);

    r.commit("feat(wall-e): reach into the platform", ["apps/wall-e/x.ts", "src/lib/x.ts"]);
    const minor = next(r.plan());
    assert.deepEqual([minor.version, minor.bump], ["0.2.0", "minor"]);
    assert.match(minor.warnings.join("\n"), /scoped wall-e but changes src\/lib\/x\.ts, so it counts as os/);
  });

  test("on the release branch, before the merge, there is nothing to tag", () => {
    const r = repository();
    r.tag("v0.1.0");
    r.commit("feat(os): a feature", ["src/a.ts"]);
    r.git("switch", "-q", "-c", "release/v0.2.0");
    writeRelease(r.root, "0.2.0", { today: TODAY });
    r.commit(releaseSubject("0.2.0"));
    assert.throws(() => r.plan(), /this checkout is on release\/v0\.2\.0, not main/);
  });

  test("the tag goes on the release PR's merge commit, and a commit that merged first is reported", () => {
    const r = repository();
    r.tag("v0.1.0");
    r.commit("feat(os): a feature", ["src/a.ts"]);
    let late = "";
    const merge = r.releasePR("0.2.0", () => {
      late = r.commit("fix(os): merged while the release PR was open", ["src/b.ts"]);
    });
    r.commit("docs(os): after the release", ["README.md"]);

    const tagging = toTag(r.plan());
    assert.equal(tagging.commit, merge);
    assert.deepEqual(tagging.unlisted.map((c) => c.sha), [late]);
    assert.throws(() => writeRelease(r.root, "0.3.0"), /has merged and is not tagged yet/);
  });

  test("a prerelease counts from the one before it; the stable release from the last stable one", () => {
    const r = repository();
    r.tag("v0.1.0");
    r.commit("feat(os): first change", ["src/a.ts"]);
    r.tag("v0.2.0-rc.1", r.releasePR("0.2.0-rc.1"));
    r.commit("fix(os): second change", ["src/b.ts"]);

    const rc2 = next(r.plan("rc"));
    assert.deepEqual([rc2.version, rc2.since, rc2.prerelease], ["0.2.0-rc.2", "v0.2.0-rc.1", true]);
    assert.deepEqual(rc2.changes.map((c) => c.subject), ["fix(os): second change"]);
    r.releasePR("0.2.0-rc.2");
    const rc2Tag = toTag(r.plan());
    assert.match(tagCommands(rc2Tag)[2], /--prerelease$/);
    r.tag("v0.2.0-rc.2", rc2Tag.commit);

    const stable = next(r.plan());
    assert.deepEqual([stable.version, stable.since, stable.prerelease], ["0.2.0", "v0.1.0", false]);
    // Both changes, and neither prerelease's own commit.
    assert.deepEqual(stable.changes.map((c) => c.subject), ["fix(os): second change", "feat(os): first change"]);
  });

  test("written versions: package.json and the lockfile's root package, nothing else", () => {
    const r = repository();
    r.tag("v0.1.0");
    r.commit("feat(os): a feature", ["src/a.ts"]);
    const written = writeRelease(r.root, "v0.2.0", { today: TODAY });
    assert.deepEqual(written.files, ["package.json", "package-lock.json", "CHANGELOG.md"]);
    const lock = JSON.parse(fs.readFileSync(path.join(r.root, "package-lock.json"), "utf8"));
    assert.deepEqual([lock.version, lock.packages[""].version], ["0.2.0", "0.2.0"]);
    assert.deepEqual(changelogVersions(fs.readFileSync(path.join(r.root, "CHANGELOG.md"), "utf8")), ["0.2.0"]);
  });

  test("it refuses what would make the versions disagree", () => {
    const r = repository();
    r.tag("v0.1.0");
    r.commit("feat(os): a feature", ["src/a.ts"]);
    assert.throws(() => writeRelease(r.root, "0.1.0"), /not above package\.json's 0\.1\.0/);
    assert.throws(() => writeRelease(r.root, "0.2"), /is not a version/);
    assert.throws(() => planRelease(r.root, { pre: "RC1" }), /lower-case letters/);

    r.write("package.json", npmJson({ name: "mixos", version: "0.3.0", private: true }));
    r.commit("chore(os): bump by hand", ["src/b.ts"]);
    assert.throws(() => r.plan(), /no tag v0\.3\.0 and CHANGELOG\.md has no section for it/);

    r.write("package.json", '{\n    "name": "mixos",\n    "version": "0.1.0"\n}\n');
    assert.throws(() => writeRelease(r.root, "0.2.0"), /isn't formatted the way npm writes it/);
  });
});

// ── The version in a pull request, which Danger holds to a release PR ───────

describe("the version in a pull request", () => {
  const pkg = (version: string, extra: object = {}) => npmJson({ name: "mixos", version, private: true, ...extra });
  const lock = (version: string, root = version, zod = "4.4.3") =>
    npmJson({
      name: "mixos",
      version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "mixos", version: root }, "node_modules/zod": { version: zod } },
    });

  test("a change is named by file and field: package.json's version, and both of the lockfile's", () => {
    assert.deepEqual(versionChanges("package.json", pkg("0.1.0"), pkg("0.2.0")), [
      { file: "package.json", field: "version", from: "0.1.0", to: "0.2.0" },
    ]);
    assert.deepEqual(versionChanges("package-lock.json", lock("0.1.0"), lock("0.2.0")), [
      { file: "package-lock.json", field: "version", from: "0.1.0", to: "0.2.0" },
      { file: "package-lock.json", field: 'packages[""].version', from: "0.1.0", to: "0.2.0" },
    ]);
    assert.deepEqual(versionChanges("package-lock.json", lock("0.1.0"), lock("0.1.0", "0.2.0")), [
      { file: "package-lock.json", field: 'packages[""].version', from: "0.1.0", to: "0.2.0" },
    ]);
  });

  test("any other change to the two files is not one", () => {
    assert.deepEqual(versionChanges("package.json", pkg("0.1.0"), pkg("0.1.0", { scripts: { x: "y" } })), []);
    assert.deepEqual(versionChanges("package-lock.json", lock("0.1.0"), lock("0.1.0", "0.1.0", "4.5.0")), []);
    assert.deepEqual(versionChanges("package.json", pkg("0.1.0"), JSON.stringify(JSON.parse(pkg("0.1.0")))), []);
  });

  test("a field that is missing, or a file that isn't JSON, reads as none", () => {
    assert.deepEqual(versionChanges("package.json", pkg("0.1.0"), npmJson({ name: "mixos" })), [
      { file: "package.json", field: "version", from: "0.1.0", to: null },
    ]);
    assert.deepEqual(versionChanges("package.json", "<<<<<<< HEAD\n", pkg("0.2.0")), [
      { file: "package.json", field: "version", from: null, to: "0.2.0" },
    ]);
  });

  // What the v0.2.0 release PR changed: from release/v0.2.0, titled
  // "chore(os): release v0.2.0".
  const v020 = [
    ...versionChanges("package.json", pkg("0.1.0"), pkg("0.2.0")),
    ...versionChanges("package-lock.json", lock("0.1.0"), lock("0.2.0")),
  ];

  test("a release PR sets every field to one version, from the branch named after it", () => {
    assert.equal(v020.length, 3);
    assert.equal(releaseBranch("0.2.0"), "release/v0.2.0");
    assert.equal(isReleasePR("release/v0.2.0", v020), true);
    const rc = versionChanges("package.json", pkg("0.1.0"), pkg("0.2.0-rc.1"));
    assert.equal(isReleasePR("release/v0.2.0-rc.1", rc), true);
  });

  test("any other pull request that changes the version is not a release PR", () => {
    for (const branch of ["feat/try-an-extension", "release/v0.3.0", "release/0.2.0", "release/v0.2", "main"]) {
      assert.equal(isReleasePR(branch, v020), false, branch);
    }
    const split = [
      ...versionChanges("package.json", pkg("0.1.0"), pkg("0.2.0")),
      ...versionChanges("package-lock.json", lock("0.1.0"), lock("0.3.0")),
    ];
    assert.equal(isReleasePR("release/v0.2.0", split), false);
    const removed = versionChanges("package.json", pkg("0.1.0"), npmJson({ name: "mixos" }));
    assert.equal(isReleasePR("release/v0.2.0", removed), false);
    assert.equal(isReleasePR("release/v0.2.0", []), false);
  });

  test("only the core repository is held to it: a fork takes its version from the tags it merges", () => {
    assert.equal(isCoreRepository("mixoshq", "mixos"), true);
    assert.equal(isCoreRepository("MixOSHQ", "MixOS"), true);
    assert.equal(isCoreRepository("someone", "mixos"), false);
    assert.equal(isCoreRepository("mixoshq", "mixos-site"), false);
  });

  test("what --write sets is a release PR's change, from its branch only", () => {
    const r = repository();
    r.tag("v0.1.0");
    r.commit("feat(os): a feature", ["src/a.ts"]);
    writeRelease(r.root, "0.2.0", { today: TODAY });
    const changes = ["package.json", "package-lock.json"].flatMap((file) =>
      versionChanges(file, r.git("show", `HEAD:${file}`), fs.readFileSync(path.join(r.root, file), "utf8")),
    );
    assert.equal(changes.length, 3);
    assert.equal(isReleasePR(releaseBranch("0.2.0"), changes), true);
    assert.equal(isReleasePR("feat/a-feature", changes), false);
  });
});
