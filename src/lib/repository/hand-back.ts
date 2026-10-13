/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hand-back: what Register says once an extension runs in this checkout,
 * because it ships only once someone commits it. The files it added, a
 * prepared commit message, the commands, the source at the verified commit,
 * and what shipping means on each host. `npm run register` prints it
 * (scripts/register-cli.ts), and the Register result in Admin shows it, as
 * does a theme's install result, since a theme registers as it installs.
 *
 * Removing an extension's code hands back the other half (removalHandBackFor()):
 * the files the commit deletes, its message and the commands. An extension
 * installed from a Registry takes its install record with it, so the same
 * commit deletes both.
 *
 * An update hands back the change to the folder (updateHandBackFor()): the
 * files it changes, a message that names both releases, the commands, and how
 * to roll it back once it is deployed.
 *
 * The server never runs git. A web process committing to its own checkout
 * would commit whatever else is in it, and a developer's checkout usually has
 * other work on the branch, so the commands are for a person, or for
 * `/mixos deploy`.
 *
 * ── THE COMMIT MESSAGE IS BUILT FROM IDENTIFIERS ONLY ──────────────────────
 *
 * The subject is `feat(<slug>): add <kind> <slug> <version> from <host>`, the
 * form `/mixos deploy` uses, and the trailers name the record's other values.
 * Every one of them is validated by the record's schema (./install-record.ts):
 * the kind, the slug, a dotted or hex version, an origin, a commit and two
 * hashes. The manifest's `name`, which can be any non-empty string, is never
 * used: GitHub skips every workflow for a push whose head commit's message
 * holds `[skip ci]` or one of its siblings, or a `skip-checks: true` trailer,
 * and a name could carry any of them. ciSkipMarker() is the check the tests
 * hold every message to.
 *
 * Pure, and built on the server: the admin pages get a HandBack as data, with
 * its sizes already written out.
 */

import { isExtensionName } from "./backup";
import {
  INSTALL_RECORD_FILE,
  recordListingUrl,
  recordSourceUrl,
  type FolderFile,
  type InstallRecord,
} from "./install-record";
import type { UpdateDirection } from "./pending";
import { sourceHost } from "./provenance";
import { KEPT_DATA } from "./remove-outcomes";
import type { ExtensionKind } from "./types";
import type { FolderDifferences } from "./update";

/** Files listed by name; the rest are counted. */
const MAX_LISTED = 100;

/** What Register hands back, as the admin pages and the CLI show it. */
export interface HandBack {
  /** Repo-relative: `apps/files`. */
  folder: string;
  /** The files a commit of the folder adds, by path in it, sorted, at most MAX_LISTED. */
  files: { path: string; size: string }[];
  /** How many more files there are than `files` lists. */
  more: number;
  fileCount: number;
  /** Every file's size, together: `12 KB`. */
  totalSize: string;
  /** The prepared commit message: subject, body and the provenance trailers. */
  commitMessage: string;
  /** `add-app-files`. */
  branch: string;
  /** The commands, ready to paste into bash or zsh. */
  commands: string;
  /** GitHub's tree at the commit install verified. */
  sourceUrl: string | null;
  /** The listing on the catalogue it came from. */
  listingUrl: string;
  /** The catalogue's host: `mixos.org`. */
  host: string;
  /** For an update: the release it replaced, and the files the commit changes. Absent for an install. */
  update?: UpdateHandBack;
}

/** What an update's hand-back adds: what the commit replaces, and how to undo it once deployed. */
export interface UpdateHandBack {
  /** The release the folder held: `1.2.0`. */
  from: string;
  direction: UpdateDirection;
  /** The files the commit changes, against the folder it replaced. */
  changes: FolderDifferences;
  /** How to roll it back once it is deployed, in a sentence or two. */
  rollback: string;
}

/** `612 B`, `1.2 KB`, `38 KB`, `3.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `feat(files): add app files 1.2.0 from mixos.org`, or from the record's other host. */
export function commitSubject(record: InstallRecord): string {
  return `feat(${record.slug}): add ${record.kind} ${record.slug} ${record.version} from ${sourceHost(record.source)}`;
}

/** The commit message for a folder, `folder` repo-relative: subject, body and trailers. */
export function commitMessage(record: InstallRecord, folder: string): string {
  const source = recordSourceUrl(record);
  const body = [
    `Installed from ${sourceHost(record.source)} and registered in a checkout.`,
    `${folder}/.registry.json records the release and the hashes that`,
    "were verified.",
    ...(source ? ["", `The source at that commit: ${source}`] : []),
  ];
  const trailers = [
    `Registry-Source: ${record.source}`,
    `Registry-Version: ${record.version}`,
    `Registry-Commit: ${record.commitSha}`,
    `Registry-Content-Hash: ${record.contentHash}`,
    `Registry-Files-Hash: ${record.filesHash}`,
    `Registry-Listing: ${recordListingUrl(record)}`,
  ];
  const message = [commitSubject(record), "", ...body, "", ...trailers].join("\n");
  const marker = ciSkipMarker(message);
  // Unreachable while the record's schema holds: every value above is an
  // identifier. Checked anyway, as the last thing before a person commits it.
  if (marker) throw new Error(`A prepared commit message would hold ${JSON.stringify(marker)}.`);
  return message;
}

/**
 * The first thing in `text` that makes GitHub skip a push's or a pull
 * request's workflows, or null: `[skip ci]`, `[ci skip]`, `[no ci]`,
 * `[skip actions]` or `[actions skip]` anywhere, or a `skip-checks:` trailer.
 * Matched loosely (any case, any spacing), so a near miss counts too.
 */
export function ciSkipMarker(text: string): string | null {
  const bracket = /\[\s*(?:skip\s*ci|ci\s*skip|no\s*ci|skip\s*actions|actions\s*skip)\s*\]/i.exec(text);
  if (bracket) return bracket[0];
  const trailer = /^[ \t]*skip-checks[ \t]*:.*$/im.exec(text);
  return trailer ? trailer[0] : null;
}

/** `add-app-files`: a branch name from the kind and the slug. */
export function branchName(record: Pick<InstallRecord, "kind" | "slug">): string {
  return `add-${record.kind}-${record.slug}`;
}

/**
 * A path as one shell word. A path in a package can hold `$`, quotes or
 * spaces, and a command a person pastes must not run any of it.
 */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._/@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands that commit the folder on a branch of its own and push it.
 * `force` names files in it that .gitignore would leave out, which are added
 * by name. `git commit … -- <folder>` commits that folder only, whatever else
 * is staged. The message goes in on standard input, from a quoted
 * here-document, so the shell expands nothing in it.
 */
export function commandsFor(
  handBack: Pick<HandBack, "branch" | "folder" | "commitMessage">,
  force: readonly string[] = [],
): string {
  return [
    `git switch -c ${handBack.branch}`,
    `git add ${shellWord(handBack.folder)}`,
    ...(force.length > 0 ? [`git add -f ${force.map(shellWord).join(" ")}`] : []),
    `git commit -F - -- ${shellWord(handBack.folder)} <<'MSG'`,
    handBack.commitMessage,
    "MSG",
    "git push -u origin HEAD",
  ].join("\n");
}

/** The hand-back for the folder `folder` (repo-relative), holding `files`, installed as `record`. */
export function handBackFor(record: InstallRecord, folder: string, files: readonly FolderFile[]): HandBack {
  const listed = files.slice(0, MAX_LISTED);
  const message = commitMessage(record, folder);
  const branch = branchName(record);
  return {
    folder,
    files: listed.map((f) => ({ path: f.path, size: formatSize(f.bytes) })),
    more: Math.max(0, files.length - listed.length),
    fileCount: files.length,
    totalSize: formatSize(files.reduce((n, f) => n + f.bytes, 0)),
    commitMessage: message,
    branch,
    commands: commandsFor({ branch, folder, commitMessage: message }),
    sourceUrl: recordSourceUrl(record),
    listingUrl: recordListingUrl(record),
    host: sourceHost(record.source),
  };
}

/* -------------------------------------------------------------------------- */
/*  An update                                                                  */
/* -------------------------------------------------------------------------- */

/** What an update's commit is built from, besides the new release's record: the release it replaces. */
export interface ReplacedRelease {
  version: string;
  commitSha: string;
  direction: UpdateDirection;
  localChangesDiscarded: boolean;
}

/** `feat(files): update app files from 1.2.0 to 1.3.0`. Identifiers only. */
export function updateSubject(record: InstallRecord, from: Pick<ReplacedRelease, "version">): string {
  return `feat(${record.slug}): update ${record.kind} ${record.slug} from ${from.version} to ${record.version}`;
}

/**
 * The commit message for an update of the folder `folder` (repo-relative) to
 * `record`'s release: subject, body and trailers, the record's and the release
 * it replaces, each a validated value.
 */
export function updateCommitMessage(record: InstallRecord, from: ReplacedRelease, folder: string): string {
  const source = recordSourceUrl(record);
  const body = [
    ...wrap(
      `Updated from ${sourceHost(record.source)} and registered in a checkout. It replaces ${from.version}` +
        `${from.direction === "older" ? ", a newer release" : ""}. ${folder}/${INSTALL_RECORD_FILE} records the ` +
        "release and the hashes that were verified.",
    ),
    ...(from.localChangesDiscarded ? ["", ...wrap(`Local changes to ${folder} were discarded.`)] : []),
    ...(source ? ["", `The source at that commit: ${source}`] : []),
  ];
  const trailers = [
    `Registry-Source: ${record.source}`,
    `Registry-Version: ${record.version}`,
    `Registry-Commit: ${record.commitSha}`,
    `Registry-Content-Hash: ${record.contentHash}`,
    `Registry-Files-Hash: ${record.filesHash}`,
    `Registry-Listing: ${recordListingUrl(record)}`,
    `Registry-Replaces-Version: ${from.version}`,
    `Registry-Replaces-Commit: ${from.commitSha}`,
  ];
  const message = [updateSubject(record, from), "", ...body, "", ...trailers].join("\n");
  const marker = ciSkipMarker(message);
  // Unreachable while the record's schema holds: every value above is an
  // identifier. Checked anyway, as the last thing before a person commits it.
  if (marker) throw new Error(`A prepared commit message would hold ${JSON.stringify(marker)}.`);
  return message;
}

/** `update-app-files`: a branch name from the kind and the slug. */
export function updateBranchName(record: Pick<InstallRecord, "kind" | "slug">): string {
  return `update-${record.kind}-${record.slug}`;
}

/** How to undo an update once it is deployed. An app's migrations aren't undone by either way. */
export function rollbackFor(kind: ExtensionKind): string {
  return (
    "To roll it back once it is deployed, revert the commit and deploy again, or redeploy the previous build " +
    "on your host." +
    (kind === "app" ? " Neither undoes a migration it ran: only restoring a backup of the database does." : "")
  );
}

/**
 * The hand-back for an update of `folder` (repo-relative), which now holds
 * `files` as `record`'s release, in place of `from`: the change to commit, its
 * message and commands, and how to roll it back.
 */
export function updateHandBackFor(
  record: InstallRecord,
  from: ReplacedRelease,
  folder: string,
  files: readonly FolderFile[],
  changes: FolderDifferences,
): HandBack {
  const listed = files.slice(0, MAX_LISTED);
  const message = updateCommitMessage(record, from, folder);
  const branch = updateBranchName(record);
  return {
    folder,
    files: listed.map((f) => ({ path: f.path, size: formatSize(f.bytes) })),
    more: Math.max(0, files.length - listed.length),
    fileCount: files.length,
    totalSize: formatSize(files.reduce((n, f) => n + f.bytes, 0)),
    commitMessage: message,
    branch,
    commands: commandsFor({ branch, folder, commitMessage: message }),
    sourceUrl: recordSourceUrl(record),
    listingUrl: recordListingUrl(record),
    host: sourceHost(record.source),
    update: { from: from.version, direction: from.direction, changes, rollback: rollbackFor(record.kind) },
  };
}

/** What shipping it means on each host, a sentence each. */
export const SHIPPING = {
  hosted:
    "Merging it into the branch your host deploys ships it on Coolify, Dokploy, Render, Railway and Vercel.",
  compose:
    "With Docker Compose on your own server, pull it there, then build, migrate and start, as in " +
    "docs/hosting/docker-compose.md#upgrading.",
} as const;

/** A path git would leave out of the commit, and the rule that does it. */
export interface IgnoredPath {
  /** Repo-relative. */
  path: string;
  /** Where the rule is, as git says it: `.gitignore:22:*.pem`. */
  rule: string;
}

/**
 * The hand-back as lines for a terminal, after `npm run register` has said
 * what it registered. `ignored` is what the CLI found git would leave out.
 * The commands are printed as they are, unindented: a here-document's lines
 * are the message's, and its end marker has to start its line.
 */
export function handBackLines(
  handBack: HandBack,
  { isApp, ignored = [] }: { isApp: boolean; ignored?: readonly IgnoredPath[] },
): string[] {
  const width = Math.max(0, ...handBack.files.map((f) => f.path.length));
  const update = handBack.update;
  const lines = update
    ? [
        "",
        `It runs in this checkout now, and nowhere else until you commit the change to ${handBack.folder} and deploy it.`,
        "",
        ...changeLines(handBack.folder, update.changes),
      ]
    : [
        "",
        `It runs in this checkout now, and nowhere else until you commit ${handBack.folder} and deploy it.`,
        "",
        `Files added in ${handBack.folder}/ (${handBack.fileCount} ${handBack.fileCount === 1 ? "file" : "files"}, ${handBack.totalSize}):`,
        ...handBack.files.map((f) => `    ${f.path.padEnd(width)}  ${f.size}`),
        ...(handBack.more > 0 ? [`    and ${handBack.more} more`] : []),
      ];
  if (ignored.length > 0) {
    lines.push(
      "",
      `Your .gitignore leaves ${ignored.length === 1 ? "this file" : `these ${ignored.length} files`} out of ` +
        `\`git add ${handBack.folder}\`, so a commit would not hold the folder that was verified. ` +
        `The commands below add ${ignored.length === 1 ? "it" : "them"} by name:`,
      ...ignored.map((i) => `    ${i.path}  (${i.rule})`),
    );
  }
  lines.push(
    "",
    update
      ? "Commit it on a branch of its own, and push. The message records both releases and where they came from:"
      : "Commit it on a branch of its own, and push. The message records where it came from:",
    "",
    commandsFor(handBack, ignored.map((i) => i.path)),
    "",
    "Or run /mixos deploy, which branches, commits, pushes and opens a pull request.",
    "",
    ...(handBack.sourceUrl ? ["The source, at the commit that was verified:", `    ${handBack.sourceUrl}`, ""] : []),
    SHIPPING.hosted,
    SHIPPING.compose,
  );
  if (update) lines.push(update.rollback);
  else if (isApp) lines.push("It arrives inactive on each instance: activate it there, in Admin > Apps.");
  return lines;
}

/** An update's changed, added and deleted files, for a terminal. */
function changeLines(folder: string, changes: FolderDifferences): string[] {
  const count = (n: number, more: number) => n + more;
  const changed = count(changes.changed.length, changes.more.changed);
  const added = count(changes.added.length, changes.more.added);
  const removed = count(changes.removed.length, changes.more.removed);
  const lines = [`What the commit changes in ${folder}/ (${changed} changed, ${added} added, ${removed} deleted):`];
  const group = (word: string, names: string[], more: number) => {
    for (const name of names) lines.push(`    ${word.padEnd(7)}  ${name}`);
    if (more > 0) lines.push(`    and ${more} more ${word}`);
  };
  group("changed", changes.changed, changes.more.changed);
  group("added", changes.added, changes.more.added);
  group("deleted", changes.removed, changes.more.removed);
  if (changes.incomplete) lines.push("    The folder holds too many files to list them all.");
  return lines;
}

/* -------------------------------------------------------------------------- */
/*  Removal                                                                    */
/* -------------------------------------------------------------------------- */

/** What a removal's commit is built from: identifiers, each validated before it gets here. */
export interface RemovalTarget {
  kind: ExtensionKind;
  /** The folder's name, which isExtensionName() holds to letters, digits, `-` and `_`. */
  slug: string;
  /** Where it was installed from, from its own install record, or null for a local one. */
  installed: Pick<InstallRecord, "source" | "version"> | null;
}

/** What removal hands back: the commit that deletes the folder, and how to make it. */
export interface RemovalHandBack {
  /** Repo-relative: `apps/files`. */
  folder: string;
  /** The files the commit deletes, by path in the folder, sorted, at most MAX_LISTED. */
  files: { path: string; size: string }[];
  /** How many more there are than `files` lists. */
  more: number;
  fileCount: number;
  /** Every file's size, together: `12 KB`. */
  totalSize: string;
  /** The prepared commit message: subject, body and, for an install, two trailers. */
  commitMessage: string;
  /** `remove-app-files`. */
  branch: string;
  /** The commands, ready to paste into bash or zsh. */
  commands: string;
  /** The catalogue's host it was installed from, `mixos.org`, or null for a local one. */
  installedFrom: string | null;
}

function assertRemovalTarget(target: RemovalTarget): void {
  // The record's schema has checked the version and the source already. The
  // name comes from the folder, so it is checked here, where it becomes words
  // in a commit.
  if (!isExtensionName(target.slug)) throw new Error(`"${target.slug}" is not the name of an extension folder.`);
}

/** `feat(files): remove app files 1.2.0 from mixos.org`, or `feat(files): remove app files` for a local one. */
export function removalSubject(target: RemovalTarget): string {
  assertRemovalTarget(target);
  const base = `feat(${target.slug}): remove ${target.kind} ${target.slug}`;
  return target.installed ? `${base} ${target.installed.version} from ${sourceHost(target.installed.source)}` : base;
}

/** `text` in lines of at most `width` columns, broken between words; a longer word gets a line of its own. */
function wrap(text: string, width = 72): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return line ? [...lines, line] : lines;
}

/** The commit message for deleting `folder` (repo-relative): subject, body and, for an install, its trailers. */
export function removalCommitMessage(target: RemovalTarget, folder: string): string {
  const body = [
    ...wrap(`Removed in a checkout. ${KEPT_DATA[target.kind]}`),
    ...(target.installed ? ["", ...wrap(`Its install record, ${folder}/${INSTALL_RECORD_FILE}, goes with it.`)] : []),
  ];
  const trailers = target.installed
    ? ["", `Registry-Source: ${target.installed.source}`, `Registry-Version: ${target.installed.version}`]
    : [];
  const message = [removalSubject(target), "", ...body, ...trailers].join("\n");
  const marker = ciSkipMarker(message);
  // Unreachable while the name and the record hold to their patterns: checked
  // anyway, as the last thing before a person commits it.
  if (marker) throw new Error(`A prepared commit message would hold ${JSON.stringify(marker)}.`);
  return message;
}

/** `remove-app-files`: a branch name from the kind and the name. */
export function removalBranchName(target: Pick<RemovalTarget, "kind" | "slug">): string {
  return `remove-${target.kind}-${target.slug}`;
}

/**
 * The commands that commit the deletion on a branch of its own and push it.
 * The folder is already gone from the disk: `git rm -r` stages that, and
 * `git commit … -- <folder>` commits the folder only, whatever else is staged.
 * The message goes in on standard input, from a quoted here-document, so the
 * shell expands nothing in it.
 */
export function removalCommandsFor(handBack: Pick<RemovalHandBack, "branch" | "folder" | "commitMessage">): string {
  return [
    `git switch -c ${handBack.branch}`,
    `git rm -r ${shellWord(handBack.folder)}`,
    `git commit -F - -- ${shellWord(handBack.folder)} <<'MSG'`,
    handBack.commitMessage,
    "MSG",
    "git push -u origin HEAD",
  ].join("\n");
}

/** The hand-back for removing `folder` (repo-relative), which held `files`. */
export function removalHandBackFor(
  target: RemovalTarget,
  folder: string,
  files: readonly FolderFile[],
): RemovalHandBack {
  const listed = files.slice(0, MAX_LISTED);
  const message = removalCommitMessage(target, folder);
  const branch = removalBranchName(target);
  return {
    folder,
    files: listed.map((f) => ({ path: f.path, size: formatSize(f.bytes) })),
    more: Math.max(0, files.length - listed.length),
    fileCount: files.length,
    totalSize: formatSize(files.reduce((n, f) => n + f.bytes, 0)),
    commitMessage: message,
    branch,
    commands: removalCommandsFor({ branch, folder, commitMessage: message }),
    installedFrom: target.installed ? sourceHost(target.installed.source) : null,
  };
}

/**
 * The removal's hand-back as lines for a terminal, after `npm run remove` has
 * said what it removed and what each instance keeps. `tracked` is whether git
 * tracked any of the folder, which `npm run remove` asks it, read-only: false
 * means there is nothing to commit, and null that it couldn't tell.
 */
export function removalHandBackLines(
  handBack: RemovalHandBack,
  { tracked = null }: { tracked?: boolean | null } = {},
): string[] {
  const width = Math.max(0, ...handBack.files.map((f) => f.path.length));
  const lines = [
    "",
    `It is gone from this checkout only. Commit the deletion of ${handBack.folder} and deploy to remove it from your instances.`,
    "",
    `Files deleted from ${handBack.folder}/ (${handBack.fileCount} ${handBack.fileCount === 1 ? "file" : "files"}, ${handBack.totalSize}):`,
    ...handBack.files.map((f) => `    ${f.path.padEnd(width)}  ${f.size}`),
    ...(handBack.more > 0 ? [`    and ${handBack.more} more`] : []),
    "",
  ];
  if (tracked === false) {
    lines.push(`Git doesn't track ${handBack.folder}: it was never committed, so there is nothing to commit.`);
  } else {
    lines.push(
      "Commit it on a branch of its own, and push. The message records what was removed:",
      "",
      removalCommandsFor(handBack),
      "",
      "Or run /mixos deploy, which branches, commits, pushes and opens a pull request.",
      "",
      SHIPPING.hosted,
      SHIPPING.compose,
    );
  }
  return lines;
}
