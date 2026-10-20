/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prepares a version release of MixOS: works out the next version from the
 * commits since the last release, writes the release PR's files, and prints a
 * release's notes for its GitHub Release. It also tells Danger whether a pull
 * request's change to the version is a release PR's.
 *
 * Not the release step. `npm run release` (scripts/release.ts) migrates a
 * deployment's database. This script has nothing to do with databases, and the
 * release step has nothing to do with versions.
 *
 * A release is three things, in order
 * (docs/plans/20260921_0842-release-versioning.md):
 *
 *   1. A release PR that sets package.json's version and adds the version's
 *      section to CHANGELOG.md. This script writes both.
 *   2. An annotated tag vX.Y.Z on the commit that PR put on main, created and
 *      pushed by a person after the merge.
 *   3. A GitHub Release for that tag, whose notes are the CHANGELOG.md section.
 *
 * `/mixos deploy release` drives the three (.claude/skills/mixos/actions/
 * deploy.md). This script never commits, tags or pushes. It reads local git
 * refs only, so fetch the tags first.
 *
 *   npx tsx scripts/release-prep.ts                # the next version and its notes, or the release to tag
 *   npx tsx scripts/release-prep.ts --pre          # the same for a prerelease, -rc.N (--pre beta: -beta.N)
 *   npx tsx scripts/release-prep.ts --write 0.2.0  # write package.json, package-lock.json, CHANGELOG.md
 *   npx tsx scripts/release-prep.ts --notes 0.2.0  # print 0.2.0's notes from CHANGELOG.md
 *
 * ── THE VERSION ─────────────────────────────────────────────────────────────
 *
 * While MixOS is 0.x, a release is a minor version if any commit since the last
 * stable release is breaking (`!` or a `BREAKING CHANGE:` footer), is scoped
 * `os`, or changes a file outside apps/, connectors/ and themes/ (build plans
 * aside, as dangerfile.ts counts them). Otherwise it is a patch. A commit that
 * changes platform files under another scope counts as an `os` commit, and is
 * reported. The first release is the version package.json already holds. A
 * prerelease is the next version with `-rc.N` appended, N one more than the
 * highest already tagged.
 *
 * ── THE NOTES ───────────────────────────────────────────────────────────────
 *
 * A stable release lists the commits since the previous stable release, so a
 * reader who skipped the prereleases misses nothing. A prerelease lists the
 * commits since the previous prerelease of the same version. Breaking changes
 * come first, with their footers, then features, fixes, performance and
 * operations. Documentation, tests, refactors and chores are left out. A
 * subject that isn't a Conventional Commit is listed under "Other changes"
 * rather than dropped. Release commits are never counted.
 *
 * Subjects are plain text, and the notes are Markdown that GitHub renders on
 * the release page, so `<`, `>`, `[` and `]` are escaped outside code spans: a
 * merged pull request's title can't add a link, an image or HTML to the notes.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The core repository. Release notes link into it at the release's own tag. */
export const REPOSITORY = "https://github.com/mixoshq/mixos";

/** Whether `owner/repo` is the core repository, where releases are cut. Anyone else's copy takes its versions from the core's tags. */
export function isCoreRepository(owner: string, repo: string): boolean {
  return `https://github.com/${owner}/${repo}`.toLowerCase() === REPOSITORY.toLowerCase();
}

/** The subject of a release PR's commit. Never counted in a later release. */
export function releaseSubject(version: string): string {
  return `chore(os): release v${version}`;
}
const RELEASE_SUBJECT = /^chore\(os\): release v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The branch a release PR is opened from, as `/mixos deploy release` names it. */
export function releaseBranch(version: string): string {
  return `release/v${version}`;
}

// ── Versions ────────────────────────────────────────────────────────────────

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers, `["rc", "1"]` for `-rc.1`. Empty for a stable release. */
  pre: string[];
}

// Narrower than semver: prerelease identifiers are letters and digits, joined by
// dots (`-rc.1`, not `-rc-1`), and there is no build metadata.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

/** `0.2.0`, `v0.2.0` or `0.2.0-rc.1`; null for anything else. */
export function parseVersion(raw: string): Version | null {
  const m = VERSION.exec(raw.trim().replace(/^v/, ""));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

export function formatVersion(v: Version): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre.length > 0 ? `${core}-${v.pre.join(".")}` : core;
}

/** Semver precedence, -1, 0 or 1: `0.2.0-rc.2` < `0.2.0-rc.10` < `0.2.0` < `0.2.1`. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  // A prerelease sorts below the release it leads to.
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const sameCore = (a: Version, b: Version) =>
  a.major === b.major && a.minor === b.minor && a.patch === b.patch;

export type Bump = "minor" | "patch";

/** The 0.x rule. Past 1.0 the rule is not decided, so this refuses rather than guess. */
export function bumpVersion(from: Version, bump: Bump): Version {
  if (from.major !== 0) {
    throw new Error(
      `The bump rule covers 0.x only, and the last release is ${formatVersion(from)}. ` +
        "Decide the 1.x rule in docs/plans/20260921_0842-release-versioning.md, " +
        "and until then pass the version you want to --write.",
    );
  }
  return bump === "minor"
    ? { major: 0, minor: from.minor + 1, patch: 0, pre: [] }
    : { major: 0, minor: from.minor, patch: from.patch + 1, pre: [] };
}

// ── Commits ─────────────────────────────────────────────────────────────────

export interface RawCommit {
  sha: string;
  short: string;
  subject: string;
  body: string;
  files: string[];
}

export interface Change {
  sha: string;
  short: string;
  subject: string;
  /** The Conventional Commit type, lower-cased; null when the subject isn't one. */
  type: string | null;
  scopes: string[];
  /** The subject after `type(scope)!: `, or the whole subject when it isn't one. */
  summary: string;
  breaking: boolean;
  /** The text of the `BREAKING CHANGE:` footer, when there is one. */
  note: string | null;
  /** Files it changes outside apps/, connectors/ and themes/, build plans aside. */
  osFiles: string[];
}

const SUBJECT = /^([A-Za-z]+)(?:\(([^()]*)\))?(!)?: (.+)$/;
const FOOTER = /^BREAKING[ -]CHANGE: ?/;
// The trailers that follow a footer: Co-Authored-By:, Signed-off-by:, Refs: …
const TRAILER = /^(?:[A-Za-z]+-[A-Za-z-]+|Refs|Closes|Fixes): /i;

const EXTENSION_DIRS = ["apps/", "connectors/", "themes/"];
/** A platform file, as dangerfile.ts counts one: build plans describe work and do none. */
export const isOsFile = (file: string) =>
  !EXTENSION_DIRS.some((dir) => file.startsWith(dir)) && !/^docs\/plans\/.+\.md$/i.test(file);

export function toChange(c: RawCommit): Change {
  const m = SUBJECT.exec(c.subject.trim());
  const lines = c.body.split("\n");
  const start = lines.findIndex((line) => FOOTER.test(line));
  let note: string | null = null;
  if (start !== -1) {
    const text = [lines[start].replace(FOOTER, "")];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "" || TRAILER.test(line)) break;
      text.push(line);
    }
    note = text.join("\n").trim() || null;
  }
  return {
    sha: c.sha,
    short: c.short,
    subject: c.subject,
    type: m ? m[1].toLowerCase() : null,
    scopes: m?.[2] ? m[2].split(",").map((s) => s.trim()).filter(Boolean) : [],
    summary: (m ? m[4] : c.subject).trim(),
    breaking: Boolean(m?.[3]) || start !== -1,
    note,
    osFiles: c.files.filter(isOsFile),
  };
}

/** Why a change makes the release a minor one, or null when it doesn't. */
export function minorBecause(c: Change): string | null {
  if (c.breaking) return "breaking";
  if (c.scopes.includes("os")) return "scoped os";
  if (c.osFiles.length > 0) return `changes ${listFiles(c.osFiles)}`;
  return null;
}

/** Minor when any change is breaking, `os`, or touches platform files; patch otherwise. */
export function bumpFor(changes: Change[]): Bump {
  return changes.some((c) => minorBecause(c) !== null) ? "minor" : "patch";
}

const listFiles = (files: string[]) =>
  files.length <= 2 ? files.join(", ") : `${files.slice(0, 2).join(", ")} and ${files.length - 2} more`;

// ── Notes ───────────────────────────────────────────────────────────────────

const GROUPS: Record<string, string> = {
  feat: "Features",
  fix: "Fixes",
  perf: "Performance",
  ops: "Operations",
};
/** Left out of the notes: nothing an operator runs behaves differently. */
const HIDDEN = new Set(["docs", "refactor", "test", "chore", "style", "build", "ci"]);

/** Whether a change appears in the notes. Breaking changes always do. */
export const isListed = (c: Change) => c.breaking || c.type === null || !HIDDEN.has(c.type);

/** Escape what would make HTML, a link or an image, outside code spans. */
export function escapeMarkdown(text: string): string {
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[\\<>[\]]/g, "\\$&")))
    .join("");
}

function entry(c: Change): string {
  const scope = c.type !== null && c.scopes.length > 0 ? `**${escapeMarkdown(c.scopes.join(", "))}:** ` : "";
  const line = `- ${scope}${escapeMarkdown(c.summary)} (${c.short})`;
  if (!c.note) return line;
  // A paragraph of the same list item, so indented under its bullet. The
  // footer continues "BREAKING CHANGE:", so a leading lower-case word becomes
  // a sentence's first; an identifier (`get_app_schema`) is left as written.
  const note = c.note
    .replace(/^[a-z](?=[a-z]*\s)/, (first) => first.toUpperCase())
    .split("\n")
    .map((l) => `  ${escapeMarkdown(l.trim())}`)
    .join("\n");
  return `${line}\n\n${note}`;
}

export interface SectionInput {
  version: string;
  /** `YYYY-MM-DD`, the day the release PR is prepared. */
  date: string;
  /** The tag the notes count from, or null for the first release. */
  since: string | null;
  changes: Change[];
}

/** The CHANGELOG.md section for a release: its heading, then its notes. */
export function renderSection({ version, date, since, changes }: SectionInput): string {
  const whatsNew = `[WHATS-NEW.md](${REPOSITORY}/blob/v${version}/WHATS-NEW.md)`;
  const out = [`## v${version} (${date})`, ""];
  if (since === null) {
    out.push(`The first tagged release of MixOS. What changed on the way here is in ${whatsNew}.`);
    return out.join("\n");
  }
  out.push(`Changes since ${since}. The larger ones are described in ${whatsNew}.`);

  const listed = changes.filter(isListed);
  const groups: Array<[string, Change[]]> = [
    ["Breaking changes", listed.filter((c) => c.breaking)],
    ...Object.entries(GROUPS).map(([type, title]): [string, Change[]] => [
      title,
      listed.filter((c) => !c.breaking && c.type === type),
    ]),
    ["Other changes", listed.filter((c) => !c.breaking && (c.type === null || !(c.type in GROUPS)))],
  ];
  for (const [title, items] of groups) {
    if (items.length === 0) continue;
    // Entries with a footer are paragraphs, so their list is a loose one.
    const loose = items.some((c) => c.note);
    out.push("", `### ${title}`, "", items.map(entry).join(loose ? "\n\n" : "\n"));
  }
  if (listed.length === 0) out.push("", "Documentation, tests and internal changes only.");
  return out.join("\n");
}

export const CHANGELOG_HEADER = `# Changelog

Every release of MixOS, newest first. A release's section lists the
Conventional Commits since the release before it, leaving out documentation,
tests and internal changes, and is the notes of its GitHub Release.
[WHATS-NEW.md](WHATS-NEW.md) describes the larger changes in prose.

Releases are made with \`/mixos deploy release\`; see the Release section of
[.claude/skills/mixos/actions/deploy.md](.claude/skills/mixos/actions/deploy.md).
`;

const HEADING = /^## (v\S+)/;

/** The versions CHANGELOG.md has sections for, newest first. */
export function changelogVersions(changelog: string): string[] {
  return changelog
    .split("\n")
    .map((line) => HEADING.exec(line)?.[1])
    .filter((v): v is string => v !== undefined)
    .map((tag) => tag.slice(1));
}

/** Put a section above the newest one, creating the file's header the first time. */
export function insertSection(changelog: string | null, section: string): string {
  const text = changelog ?? CHANGELOG_HEADER;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => HEADING.test(line));
  if (at === -1) return `${text.replace(/\n+$/, "")}\n\n${section}\n`;
  const before = lines.slice(0, at).join("\n").replace(/\n+$/, "");
  const after = lines.slice(at).join("\n").replace(/\n+$/, "");
  return `${before}\n\n${section}\n\n${after}\n`;
}

/** A release's notes: its section without the heading. Null when there is none. */
export function notesFor(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const at = lines.findIndex((line) => HEADING.exec(line)?.[1] === `v${version}`);
  if (at === -1) return null;
  const end = lines.findIndex((line, i) => i > at && /^## /.test(line));
  return lines
    .slice(at + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

// ── The repository ──────────────────────────────────────────────────────────

type Git = (args: string[]) => string;

function gitIn(root: string): Git {
  return (args) =>
    execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
}

interface ReleaseTag {
  name: string;
  version: Version;
  annotated: boolean;
}

/** `v*` tags that parse as versions: every one, or only those `main`'s history holds. */
function releaseTags(git: Git, mergedOnly: boolean): ReleaseTag[] {
  const args = ["for-each-ref", "--format=%(refname)%09%(objecttype)"];
  if (mergedOnly) args.push("--merged", "HEAD");
  args.push("refs/tags/v*");
  return git(args)
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [ref, type] = line.split("\t");
      const name = ref.replace(/^refs\/tags\//, "");
      const version = parseVersion(name);
      return version && name === `v${formatVersion(version)}`
        ? [{ name, version, annotated: type === "tag" }]
        : [];
    });
}

const newest = (tags: ReleaseTag[]) =>
  tags.reduce<ReleaseTag | null>(
    (best, t) => (best === null || compareVersions(t.version, best.version) > 0 ? t : best),
    null,
  );

/**
 * The commits after `since` up to `until` (from the beginning when `since` is
 * null), merges and release commits aside. `--no-renames` so a file moved out
 * of src/ still shows the src/ path it left.
 */
function readChanges(git: Git, since: string | null, until = "HEAD"): Change[] {
  const out = git([
    "log",
    "--no-merges",
    "--no-renames",
    "--name-only",
    "--format=%x1e%H%x1f%h%x1f%s%x1f%b%x1f",
    since ? `${since}..${until}` : until,
    "--",
  ]);
  return out
    .split("\x1e")
    .slice(1)
    .map((record) => {
      const [sha, short, subject, body, names = ""] = record.split("\x1f");
      const files = names.split("\n").map((f) => f.trim()).filter(Boolean);
      return toChange({ sha, short, subject, body, files });
    })
    .filter((c) => !RELEASE_SUBJECT.test(c.subject));
}

function showFile(git: Git, rev: string, file: string): string | null {
  try {
    return git(["show", `${rev}:${file}`]);
  } catch {
    return null;
  }
}

function readJson(file: string): { version?: unknown } {
  return JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
}

interface State {
  git: Git;
  /** package.json's version. */
  current: string;
  /** Every release tag here, and those on `main`'s history. */
  tags: ReleaseTag[];
  merged: ReleaseTag[];
  changelog: string | null;
  /** Whether package.json's version is tagged. */
  released: boolean;
}

function readState(root: string): State {
  const git = gitIn(root);
  const current = readJson(path.join(root, "package.json")).version;
  if (typeof current !== "string" || !parseVersion(current)) {
    throw new Error(`package.json's version, ${JSON.stringify(current)}, is not X.Y.Z or X.Y.Z-id.N.`);
  }
  const changelogFile = path.join(root, "CHANGELOG.md");
  const changelog = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, "utf8") : null;
  const tags = releaseTags(git, false);
  return {
    git,
    current,
    tags,
    merged: releaseTags(git, true),
    changelog,
    released: tags.some((t) => t.name === `v${current}`),
  };
}

/**
 * Refuses unless the last release is finished (or there has been none), which
 * is when a new one can be prepared.
 */
function assertReadyForNext(s: State): void {
  if (s.released) return;
  if (s.changelog !== null && changelogVersions(s.changelog).includes(s.current)) {
    throw new Error(
      `v${s.current} has merged and is not tagged yet. Tag it and publish its GitHub Release ` +
        "(run this script without arguments for the commands) before preparing another release.",
    );
  }
  const newestTag = newest(s.tags);
  if (newestTag !== null || (s.changelog !== null && changelogVersions(s.changelog).length > 0)) {
    throw new Error(
      `package.json is at ${s.current}, but there is no tag v${s.current} ` +
        "and CHANGELOG.md has no section for it. " +
        "Between releases package.json holds the last release's version" +
        (newestTag ? ` (${newestTag.name})` : "") +
        ", and only a release PR changes it.",
    );
  }
}

/** The tag a version's notes count from: see "The notes" above. */
function notesBase(version: Version, merged: ReleaseTag[]): ReleaseTag | null {
  const stable = newest(
    merged.filter((t) => t.version.pre.length === 0 && compareVersions(t.version, version) < 0),
  );
  if (version.pre.length === 0) return stable;
  const earlier = newest(
    merged.filter(
      (t) =>
        t.version.pre.length > 0 &&
        sameCore(t.version, version) &&
        compareVersions(t.version, version) < 0,
    ),
  );
  return earlier ?? stable;
}

// ── The plan ────────────────────────────────────────────────────────────────

export type Plan =
  | {
      kind: "next";
      version: string;
      prerelease: boolean;
      /** "first": no stable release yet, so the version is package.json's. */
      bump: Bump | "first";
      /** The release the bump counts from, when there is one. */
      from: string | null;
      /** The release the notes count from, null for the first release. */
      since: string | null;
      changes: Change[];
      /** Why it's a minor release, one line each. */
      reasons: string[];
      warnings: string[];
      section: string;
    }
  | {
      kind: "tag";
      version: string;
      prerelease: boolean;
      /** The commit to tag: the first on main's first-parent line with the version's section. */
      commit: string;
      subject: string;
      /** In the release, of a kind the notes list, but not in its section. */
      unlisted: Change[];
    }
  | { kind: "nothing"; since: string };

export interface PlanOptions {
  /** A prerelease identifier: "rc" for `-rc.N`. */
  pre?: string;
  /** `YYYY-MM-DD`; today, in local time, when omitted. */
  today?: string;
}

/** Where the release stands, and what comes next. Reads; never writes. */
export function planRelease(root: string, options: PlanOptions = {}): Plan {
  const s = readState(root);
  if (!s.released && s.changelog !== null && changelogVersions(s.changelog).includes(s.current)) {
    return planTag(s, s.current);
  }
  assertReadyForNext(s);
  if (options.pre !== undefined && !/^[a-z]+$/.test(options.pre)) {
    throw new Error(`A prerelease identifier is lower-case letters, like rc or beta, not "${options.pre}".`);
  }

  const current = parseVersion(s.current)!;
  const lastStable = newest(s.merged.filter((t) => t.version.pre.length === 0));
  let core: Version;
  let bump: Bump | "first";
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (lastStable === null) {
    core = { ...current, pre: [] };
    bump = "first";
  } else {
    const counted = readChanges(s.git, lastStable.name);
    bump = bumpFor(counted);
    core = bumpVersion(lastStable.version, bump);
    reasons.push(...minorReasons(counted));
    warnings.push(...labelWarnings(counted));
  }

  let version = core;
  if (options.pre !== undefined) {
    const pre = options.pre;
    const taken = s.tags
      .filter((t) => sameCore(t.version, core) && t.version.pre.length === 2 && t.version.pre[0] === pre)
      .map((t) => Number(t.version.pre[1]))
      .filter((n) => Number.isInteger(n));
    version = { ...core, pre: [pre, String(Math.max(0, ...taken) + 1)] };
  }
  const name = formatVersion(version);
  if (s.tags.some((t) => t.name === `v${name}`)) {
    throw new Error(
      `The next version works out as v${name}, which is already tagged. ` +
        "Pass the version you want to --write.",
    );
  }
  if (s.released && compareVersions(version, current) <= 0) {
    throw new Error(
      `The next version works out as ${name}, which is not above package.json's ${s.current}. ` +
        "Pass the version you want to --write.",
    );
  }

  const base = notesBase(version, s.merged);
  const changes = readChanges(s.git, base?.name ?? null);
  if (base !== null && changes.length === 0) return { kind: "nothing", since: base.name };
  for (const t of s.tags) {
    if (!t.annotated) {
      warnings.push(`${t.name} is a lightweight tag. A release tag is annotated (git tag -a).`);
    }
  }
  const since = base?.name ?? null;
  return {
    kind: "next",
    version: name,
    prerelease: version.pre.length > 0,
    bump,
    from: lastStable?.name ?? null,
    since,
    changes,
    reasons,
    warnings,
    section: renderSection({ version: name, date: options.today ?? today(), since, changes }),
  };
}

function minorReasons(changes: Change[]): string[] {
  const breaking = changes.filter((c) => c.breaking);
  const os = changes.filter((c) => !c.breaking && c.scopes.includes("os"));
  const files = changes.filter((c) => minorBecause(c)?.startsWith("changes "));
  return [
    ...(breaking.length ? [`${breaking.length} breaking: ${breaking.map((c) => c.short).join(", ")}`] : []),
    ...(os.length ? [`${os.length} scoped os`] : []),
    ...files.map((c) => `${c.short} ${minorBecause(c)} (${c.subject})`),
  ];
}

function labelWarnings(changes: Change[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (c.type === null) {
      out.push(`${c.short} "${c.subject}" is not a Conventional Commit. It is listed under Other changes.`);
    } else if (c.osFiles.length > 0 && !c.scopes.some((s) => s === "os" || s === "deps")) {
      const scope = c.scopes.length ? `scoped ${c.scopes.join(", ")}` : "has no scope";
      out.push(`${c.short} ${scope} but changes ${listFiles(c.osFiles)}, so it counts as os.`);
    }
  }
  return out;
}

function planTag(s: State, version: string): Plan {
  // On the release branch the section is committed too, and the walk below
  // would offer to tag a commit that main doesn't have.
  const branch = s.git(["branch", "--show-current"]).trim();
  if (branch !== "main") {
    throw new Error(
      `v${version}'s section of CHANGELOG.md is committed, but this checkout is on ` +
        `${branch || "a detached HEAD"}, not main. ` +
        "The release is tagged from an up-to-date main once its PR has merged.",
    );
  }
  // Walk main's first-parent line back from HEAD while the section is there.
  // The oldest commit that has it is where the release PR landed: its merge
  // commit, or the commit itself after a squash or rebase.
  const line = s.git(["rev-list", "--first-parent", "--max-count=1000", "HEAD"]).split("\n").filter(Boolean);
  let commit: string | null = null;
  for (const sha of line) {
    const text = showFile(s.git, sha, "CHANGELOG.md");
    if (text === null || !changelogVersions(text).includes(version)) break;
    commit = sha;
  }
  if (commit === null) {
    throw new Error(
      `HEAD's CHANGELOG.md has no section for v${version}. ` +
        "Commit or discard the working tree's changes first.",
    );
  }
  const pkg = showFile(s.git, commit, "package.json");
  const atCommit = pkg === null ? undefined : (JSON.parse(pkg) as { version?: unknown }).version;
  if (atCommit !== version) {
    throw new Error(
      `The commit that added v${version}'s section to CHANGELOG.md (${commit.slice(0, 12)}) ` +
        `has package.json at ${String(atCommit)}, not ${version}.`,
    );
  }

  // A commit that reached main between the release PR's branch and its merge
  // is in the release but not in its notes. The notes name each commit by its
  // short SHA, which is how it is found. The first release lists none.
  const parsed = parseVersion(version)!;
  const base = notesBase(parsed, s.merged);
  const notes = s.changelog === null ? "" : (notesFor(s.changelog, version) ?? "");
  const named = notes.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  const unlisted =
    base === null
      ? []
      : readChanges(s.git, base.name, commit).filter(
          (c) => isListed(c) && !named.some((short) => c.sha.startsWith(short)),
        );

  return {
    kind: "tag",
    version,
    prerelease: parsed.pre.length > 0,
    commit,
    subject: s.git(["log", "-1", "--format=%s", commit]).trim(),
    unlisted,
  };
}

/** The three commands a person runs once the release PR has merged. */
export function tagCommands(plan: Extract<Plan, { kind: "tag" }>): string[] {
  const tag = `v${plan.version}`;
  const notes = `npx tsx scripts/release-prep.ts --notes ${plan.version}`;
  const publish = `gh release create ${tag} --verify-tag --title ${tag} --notes-file -`;
  return [
    `git tag -a ${tag} -m "MixOS ${tag}" ${plan.commit}`,
    `git push origin ${tag}`,
    `${notes} | ${publish}${plan.prerelease ? " --prerelease" : ""}`,
  ];
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** Set the version npm keeps in package.json, or in package-lock.json and its root package. */
function setVersion(file: string, version: string): boolean {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const data = JSON.parse(text) as { version?: string; packages?: Record<string, { version?: string }> };
  if (`${JSON.stringify(data, null, 2)}\n` !== text) {
    throw new Error(
      `${path.basename(file)} isn't formatted the way npm writes it, so setting its version ` +
        "here would reformat it. Set it with " +
        `\`npm version ${version} --no-git-tag-version --allow-same-version\` instead.`,
    );
  }
  const root = data.packages?.[""];
  if (data.version === version && (root === undefined || root.version === version)) return false;
  data.version = version;
  if (root !== undefined) root.version = version;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

export interface Written {
  version: string;
  files: string[];
  section: string;
}

/** Write a release PR's files: the version in package.json and package-lock.json, and the section. */
export function writeRelease(root: string, raw: string, options: { today?: string } = {}): Written {
  const parsed = parseVersion(raw);
  if (!parsed) throw new Error(`"${raw}" is not a version: X.Y.Z, or X.Y.Z-rc.N for a prerelease.`);
  const version = formatVersion(parsed);
  const s = readState(root);
  assertReadyForNext(s);
  if (s.released && compareVersions(parsed, parseVersion(s.current)!) <= 0) {
    throw new Error(`${version} is not above package.json's ${s.current}, the last release.`);
  }
  if (s.tags.some((t) => t.name === `v${version}`)) throw new Error(`v${version} is already tagged.`);
  if (s.changelog !== null && changelogVersions(s.changelog).includes(version)) {
    throw new Error(`CHANGELOG.md already has a section for v${version}.`);
  }

  const since = notesBase(parsed, s.merged)?.name ?? null;
  const changes = readChanges(s.git, since);
  const section = renderSection({ version, date: options.today ?? today(), since, changes });

  const files: string[] = [];
  for (const name of ["package.json", "package-lock.json"]) {
    if (setVersion(path.join(root, name), version)) files.push(name);
  }
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), insertSection(s.changelog, section));
  files.push("CHANGELOG.md");
  return { version, files, section };
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── The version in a pull request ───────────────────────────────────────────

/** A pull request's change to one of the version fields setVersion() writes. */
export interface VersionChange {
  file: string;
  /** `version`, or in package-lock.json also `packages[""].version`. */
  field: string;
  /** Null where the file has no such field, or isn't JSON. */
  from: string | null;
  to: string | null;
}

/** What `text` holds at each version field, by the name a VersionChange gives it. */
function versionFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  let data: { version?: unknown; packages?: Record<string, { version?: unknown } | undefined> } | null;
  try {
    data = JSON.parse(text);
  } catch {
    return fields;
  }
  if (typeof data?.version === "string") fields.set("version", data.version);
  const root = data?.packages?.[""]?.version;
  if (typeof root === "string") fields.set('packages[""].version', root);
  return fields;
}

/** The version fields at which `after`, the file as a pull request leaves it, differs from `before`. */
export function versionChanges(file: string, before: string, after: string): VersionChange[] {
  const was = versionFields(before);
  const is = versionFields(after);
  return ["version", 'packages[""].version']
    .filter((field) => was.get(field) !== is.get(field))
    .map((field) => ({ file, field, from: was.get(field) ?? null, to: is.get(field) ?? null }));
}

/**
 * Whether a pull request from `branch` that makes `changes` is a release PR:
 * every field set to one version, from the branch `/mixos deploy release`
 * names after it. Danger fails any other pull request that changes the
 * version (dangerfile.ts).
 */
export function isReleasePR(branch: string, changes: VersionChange[]): boolean {
  const version = changes[0]?.to;
  return (
    typeof version === "string" &&
    parseVersion(version) !== null &&
    changes.every((c) => c.to === version) &&
    branch === releaseBranch(version)
  );
}

// ── The command ─────────────────────────────────────────────────────────────

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function printPlan(plan: Plan): void {
  if (plan.kind === "nothing") {
    console.log(`Nothing to release: no commits since ${plan.since}.`);
    return;
  }
  if (plan.kind === "tag") {
    const tag = `v${plan.version}`;
    const out = [
      `${tag} has merged and is not tagged yet.`,
      `Release commit: ${plan.commit.slice(0, 12)} ${plan.subject}`,
      `  (the first commit on main with ${tag}'s section of CHANGELOG.md)`,
    ];
    if (plan.unlisted.length > 0) {
      out.push("", "In the release but not in its notes:");
      for (const c of plan.unlisted) out.push(`  - ${c.short} ${c.subject}`);
    }
    out.push("", "For a person to run, from this checkout:", "", ...tagCommands(plan).map((c) => `  ${c}`));
    console.log(out.join("\n"));
    return;
  }

  const kind =
    plan.bump === "first"
      ? "the first release, at the version package.json already holds"
      : `a ${plan.bump} release since ${plan.from}`;
  const out = [`Next release: v${plan.version}, ${kind}${plan.prerelease ? " (a prerelease)" : ""}.`];
  if (plan.since === null) {
    out.push(
      `It holds every commit so far (${plan.changes.length}). ` +
        "With no release before it, the notes don't list them.",
    );
  } else {
    const hidden = plan.changes.filter((c) => !isListed(c));
    const byType = [...new Set(hidden.map((c) => c.type))]
      .map((t) => `${hidden.filter((c) => c.type === t).length} ${t}`)
      .join(", ");
    const listed = plan.changes.length - hidden.length;
    out.push(
      `Since ${plan.since}: ${count(plan.changes.length, "commit")}, ${listed} in the notes` +
        (hidden.length ? `, ${hidden.length} left out (${byType}).` : "."),
    );
  }
  if (plan.bump === "minor") {
    out.push("", "Minor, because:", ...plan.reasons.map((r) => `  - ${r}`));
  } else if (plan.bump === "patch") {
    out.push("", `Patch: no commit since ${plan.from} is breaking, scoped os, or changes platform files.`);
  }
  if (plan.warnings.length > 0) out.push("", "Check:", ...plan.warnings.map((w) => `  - ${w}`));
  out.push(
    "",
    "The CHANGELOG.md section:",
    "",
    plan.section,
    "",
    "Write it, with this version or another:",
    `  npx tsx scripts/release-prep.ts --write ${plan.version}`,
  );
  console.log(out.join("\n"));
}

function main(argv: string[]): void {
  const root = path.resolve(__dirname, "..");
  const [flag, value] = argv;
  if (flag === "--write" && value) {
    const written = writeRelease(root, value);
    console.log(`Wrote ${written.files.join(", ")} for v${written.version}.\n\n${written.section}`);
  } else if (flag === "--notes" && value) {
    const changelogFile = path.join(root, "CHANGELOG.md");
    const notes = fs.existsSync(changelogFile)
      ? notesFor(fs.readFileSync(changelogFile, "utf8"), value.replace(/^v/, ""))
      : null;
    if (notes === null) throw new Error(`CHANGELOG.md has no section for v${value.replace(/^v/, "")}.`);
    process.stdout.write(`${notes}\n`);
  } else if (flag === undefined || (flag === "--pre" && argv.length <= 2)) {
    printPlan(planRelease(root, { pre: flag === "--pre" ? (value ?? "rc") : undefined }));
  } else {
    throw new Error(
      "Usage: npx tsx scripts/release-prep.ts [--pre [id]] | --write <version> | --notes <version>",
    );
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
