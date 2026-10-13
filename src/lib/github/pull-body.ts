/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The body of a proposal's pull request: what was verified, what will run
 * and when, the release's MixOS floor, a withdrawal an admin accepted, and
 * what merging does on this host.
 *
 * ── WHOSE WORDS ─────────────────────────────────────────────────────────────
 *
 * Everything outside the last section is this instance's: fixed text, and
 * values the install record's schema validated (the kind, the slug, a version,
 * a commit, hashes, an origin), set in code spans. What the publisher wrote
 * (the extension's name, their handle, the permissions they claim, a
 * withdrawal's reason, a floor that isn't a version) appears only in that last
 * section, labelled as their claims, inside a fenced block, one line each:
 * newlines and control characters collapsed, and `\`, `[`, `]`, `@` and `#`
 * escaped. A fence can't hold a mention, a link or an issue reference, the
 * escapes keep them inert if anything ever renders the text outside one, and
 * the fence is longer than any run of backticks in it, so nothing can close it
 * early. File paths are the publisher's too, so the body counts files and
 * never names them; the diff shows them.
 *
 * An update's body (updateProposalBody()) adds what changes, from the release
 * the folder holds to the one it goes to: the files by count, the manifest's
 * declarations by row, an app's migrations by count, and which way it goes;
 * and that rolling back is reverting the merge. A removal's
 * (removalProposalBody()) says what goes, that the data stays on each
 * instance until an admin deletes it there, and the same way back. The values
 * a manifest declares (hosts, keys, names) are the publisher's, so they go in
 * the fence too; the rows' labels are this instance's.
 *
 * Pure: ./propose.ts and ./propose-change.ts give it what it says.
 */

import type { FloorVerdict } from "@/lib/platform/version-floor";
import { leftOutLine, type LeftOut } from "@/lib/repository/left-out";
import { recordSourceUrl, type InstallRecord } from "@/lib/repository/install-record";
import type { UpdateDirection } from "@/lib/repository/pending";
import { sourceHost } from "@/lib/repository/provenance";
import { KEPT_DATA } from "@/lib/repository/remove-outcomes";
import type { RemovalNote } from "@/lib/repository/remove";
import type { RunGroup } from "@/lib/repository/review";
import { KIND_LABEL } from "@/lib/repository/types";
import type { DeclarationChange, FolderDifferences, MigrationChanges } from "@/lib/repository/update";
import { extensionFolder } from "./names";

/** Where this instance runs, as far as merging goes. */
export type Host = "vercel" | "render" | "railway" | "image";

export interface ProposalBodyInput {
  /** What was verified: the record the pull request adds. */
  record: InstallRecord;
  /** What install left out, by name. */
  leftOut: LeftOut;
  /** What runs, by group, for an app or a connector. Null for a theme, which runs none. */
  runs: RunGroup[] | null;
  /** How many `migrations/*.sql` files it has. */
  migrations: number;
  /** The release's floor against the instance that proposes it. */
  floor: FloorVerdict;
  /** Set when the release is withdrawn and an admin proposed it anyway. */
  yanked: { reason: string | null } | null;
  /** What the publisher says, from mixos.org: never checked, only shown. */
  claims: {
    name: string;
    publisher: string | null;
    permissions: { scope: string; reason: string }[];
  };
  host: Host;
}

/** Each claim's line is cut here. */
const MAX_CLAIM_CHARS = 300;
/** Claims shown; the rest are counted. */
const MAX_CLAIMS = 40;
/** GitHub takes up to 65,536 characters; this stays well inside it. */
export const MAX_BODY_CHARS = 60_000;

/**
 * One claim as a line of the fenced block: `label: text`, flattened to one
 * line, capped, and escaped. Exported for its tests.
 */
export function claimLine(label: string, text: string): string {
  const flat = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const capped = flat.length > MAX_CLAIM_CHARS ? `${flat.slice(0, MAX_CLAIM_CHARS - 1)}…` : flat;
  const escaped = capped.replace(/\\/g, "\\\\").replace(/[[\]@#]/g, (c) => `\\${c}`);
  return `${label}: ${escaped || "(empty)"}`;
}

/** `lines` in a fenced block whose fence no run of backticks in them can close. */
export function fenced(lines: string[]): string {
  const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((run) => run.length)));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}text`, ...lines, fence].join("\n");
}

/** A plain `X.Y.Z` (or `X`, `X.Y`) the body can print as itself. */
const PLAIN_VERSION = /^\d{1,6}(?:\.\d{1,6}){0,2}$/;

function floorLine(floor: FloorVerdict): string | null {
  if (!floor.declared) return "**MixOS floor:** none declared.";
  if (!PLAIN_VERSION.test(floor.declared)) {
    return "**MixOS floor:** declared, but not as a version, so it isn't checked. It is with the claims below.";
  }
  const current = PLAIN_VERSION.test(floor.current) ? ` The instance that proposed it runs ${floor.current},` : "";
  return (
    `**MixOS floor:** ${floor.declared} or newer.${current}` +
    `${current ? (floor.met ? " which meets it." : " which doesn't meet it.") : ""} ` +
    "Every build checks it again, and stops on a floor it doesn't meet."
  ).replace(/\s+/g, " ");
}

function mergeLine(host: Host, migrations: number): string {
  const first = migrations > 0 ? " Its release step applies the migrations first." : "";
  switch (host) {
    case "vercel":
      return `Vercel builds the merge and puts it into production.${
        migrations > 0 ? " The production build's release step applies the migrations before it goes live." : ""
      }`;
    case "render":
      return `Render deploys the merge.${first} The new version takes traffic once it is healthy.`;
    case "railway":
      return `Railway deploys the merge.${first} The new version takes traffic once it is healthy.`;
    case "image":
      return (
        "Coolify and Dokploy deploy the merge when auto-deploy is on. With Docker Compose, pull it on the server, " +
        "then build, migrate and start."
      );
  }
}

/** The pull request's body. */
export function proposalBody(input: ProposalBodyInput): string {
  const { record: r, floor } = input;
  const label = KIND_LABEL[r.kind].one.toLowerCase();
  const folder = extensionFolder(r.kind, r.slug);
  const host = sourceHost(r.source);
  const source = recordSourceUrl(r);
  const leftOut = leftOutLine(input.leftOut);

  const verified = [
    `- **Release:** \`${r.version}\`${r.gitTag ? ` (tag \`${r.gitTag}\`)` : ""}, commit \`${r.commitSha}\`.`,
    `- **Content hash:** \`${r.contentHash}\`, checked against the hash ${host} published, over the package as published.`,
    `- **Files hash:** \`${r.filesHash}\`, over the files in \`${folder}/\` other than \`.registry.json\`, which records both.`,
    ...(source ? [`- **Source at that commit:** ${source}`] : []),
    `- ${floorLine(floor)}`,
    ...(leftOut ? [`- ${leftOut}`] : []),
    ...(input.yanked
      ? ["- **Withdrawn by its publisher.** An admin proposed it anyway. The reason is with the claims below."]
      : []),
  ];

  const runs = input.runs
    ? input.runs
        .map((g) => ({ label: g.label, count: g.files.length + g.more }))
        .filter((g) => g.count > 0)
        .map((g) => `\`${g.label}\` (${g.count} ${g.count === 1 ? "file" : "files"})`)
    : [];
  const willRun = [
    "- **Before you merge:** this repository's checks, on this pull request. The build runs the registry " +
      `generator, which checks the ${label}. Nothing else has run it.`,
    `- **When you merge:** ${mergeLine(input.host, input.migrations)}`,
    ...(r.kind === "app" ? ["- **Then:** it arrives inactive. Activate it on Admin > Apps."] : []),
    r.kind === "theme"
      ? "- **Code:** none. A theme is CSS and assets."
      : runs.length > 0
        ? `- **Code it runs:** ${runs.join(", ")}.`
        : "- **Code it runs:** none found.",
    ...(input.migrations > 0
      ? ["- **Migrations** only go forward. Back up the database before you merge."]
      : []),
  ];

  const claims = [
    claimLine("name", input.claims.name),
    ...(input.claims.publisher ? [claimLine("publisher", input.claims.publisher)] : []),
    ...input.claims.permissions.slice(0, MAX_CLAIMS).map((p) => claimLine("permission", `${p.scope} - ${p.reason}`)),
    ...(input.claims.permissions.length > MAX_CLAIMS
      ? [`and ${input.claims.permissions.length - MAX_CLAIMS} more permissions`]
      : []),
    ...(floor.declared && !PLAIN_VERSION.test(floor.declared) ? [claimLine("requires MixOS", floor.declared)] : []),
    ...(input.yanked ? [claimLine("withdrawn", input.yanked.reason ?? "no reason given")] : []),
  ];

  const body = [
    `Adds the ${label} \`${r.slug}\` ${r.version} from ${host}. An admin proposed it from MixOS, through the ` +
      "GitHub App. Nothing in it has run yet.",
    "",
    "### What was verified",
    "",
    ...verified,
    "",
    "### What will run, and when",
    "",
    ...willRun,
    "",
    "### The publisher's claims",
    "",
    `As the publisher wrote them on ${host}. MixOS doesn't check them: the ${label}'s own manifest is what it enforces.`,
    "",
    fenced(claims),
    "",
  ].join("\n");
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 20)}\n\n(cut short)\n` : body;
}

/* -------------------------------------------------------------------------- */
/*  An update                                                                   */
/* -------------------------------------------------------------------------- */

export interface UpdateBodyInput {
  /** The release it goes to: the record the pull request writes. */
  record: InstallRecord;
  /** The release the folder holds, as this build records it. */
  from: { version: string; commitSha: string };
  direction: UpdateDirection;
  /** What the tree changes in the folder. */
  changes: FolderDifferences;
  /** What the manifest declares, the rows that change. Null when either manifest can't be read; empty for a theme. */
  declarations: DeclarationChange[] | null;
  /** An app's migrations, from the folder's release to the new one. Empty for the other kinds. */
  migrations: MigrationChanges;
  /** GitHub's compare view of the two commits in the source repository, or null across repositories. */
  compareUrl: string | null;
  leftOut: LeftOut;
  runs: RunGroup[] | null;
  floor: FloorVerdict;
  yanked: { reason: string | null } | null;
  claims: ProposalBodyInput["claims"];
  host: Host;
}

/** How many a cut list names: its entries, and the "and N more" the cut appends. */
function countListed(list: readonly string[]): number {
  return list.reduce((n, item) => {
    const more = /^and (\d+) more$/.exec(item);
    return n + (more ? Number(more[1]) : 1);
  }, 0);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The manifest's declarations, in one line by row, with the values left for the fence. */
function declarationsLine(declarations: DeclarationChange[] | null, kind: InstallRecord["kind"]): string {
  if (kind === "theme") return "- **Manifest:** a theme declares nothing that runs.";
  if (declarations === null) return "- **Manifest:** one of the two manifests can't be read, so what it declares isn't compared here.";
  if (declarations.length === 0) {
    return `- **Manifest:** no change to what it declares (${
      kind === "app" ? "egress, env, database, connectors, services, hooks, MCP tools" : "hosts, credentials, accounts, webhooks"
    }).`;
  }
  const rows = declarations.map(
    (row) => `${row.label} (${countListed(row.added)} added, ${countListed(row.removed)} dropped)`,
  );
  return `- **Manifest:** changes to ${rows.join(", ")}. The values are with the claims below.`;
}

/** An app's migrations, in a line: new ones are forward-only; ones the target lacks aren't undone. */
function migrationsLine(migrations: MigrationChanges, from: string, to: string): string {
  const parts: string[] = [];
  if (migrations.added.length > 0) {
    parts.push(
      `${plural(migrations.added.length, "new migration")} in \`${to}\`. The release step applies them, and they are ` +
        "forward-only: back up the database before you merge.",
    );
  }
  if (migrations.lacking.length > 0) {
    parts.push(
      `${plural(migrations.lacking.length, "migration")} in \`${from}\` and not in \`${to}\`. A database that ran them stays ` +
        "at the newer schema: going back doesn't undo them, the older code has to cope with it, and restoring a " +
        "backup of the database may be the better way back.",
    );
  }
  if (migrations.changed.length > 0) {
    parts.push(`${plural(migrations.changed.length, "migration")} changed. Each runs once, so a database that already ran one keeps what it did.`);
  }
  return `- **Migrations:** ${parts.length > 0 ? parts.join(" ") : "no change."}`;
}

function rollbackLine(kind: InstallRecord["kind"]): string {
  return (
    "Revert the merge and deploy again, or redeploy the previous build on your host." +
    (kind === "app" ? " Neither undoes a migration the new release ran: only restoring a backup of the database does." : "")
  );
}

/** What carries over on each instance once an update is deployed. */
function carriesOver(kind: InstallRecord["kind"]): string {
  switch (kind) {
    case "app":
      return "- **Then:** its activation, grants, settings and API keys belong to its slug in each database, so they carry over.";
    case "connector":
      return "- **Then:** its credentials, and its users' connections, belong to its name in each database, so they carry over.";
    case "theme":
      return "- **Then:** an instance that applies it keeps applying it.";
  }
}

/** The pull request's body for an update. */
export function updateProposalBody(input: UpdateBodyInput): string {
  const { record: r, from, floor, changes, migrations } = input;
  const label = KIND_LABEL[r.kind].one.toLowerCase();
  const folder = extensionFolder(r.kind, r.slug);
  const host = sourceHost(r.source);
  const source = recordSourceUrl(r);
  const leftOut = leftOutLine(input.leftOut);
  const count = (names: string[], more: number) => names.length + more;

  const whatChanges = [
    `- **Files in \`${folder}/\`:** ${count(changes.changed, changes.more.changed)} changed, ${count(changes.added, changes.more.added)} added, ` +
      `${count(changes.removed, changes.more.removed)} deleted. The diff shows them.`,
    ...(input.compareUrl ? [`- **The source's own history, between the two releases:** ${input.compareUrl}`] : []),
    declarationsLine(input.declarations, r.kind),
    ...(r.kind === "app" ? [migrationsLine(migrations, from.version, r.version)] : []),
    ...(input.direction === "older"
      ? [`- **An older release.** An admin chose to go back from \`${from.version}\` to \`${r.version}\`.`]
      : input.direction === "unknown"
        ? [`- **Order unknown.** Which of \`${from.version}\` and \`${r.version}\` is newer couldn't be told. An admin chose it anyway.`]
        : []),
  ];

  const verified = [
    `- **Release:** \`${r.version}\`${r.gitTag ? ` (tag \`${r.gitTag}\`)` : ""}, commit \`${r.commitSha}\`, in place of \`${from.version}\` at commit \`${from.commitSha}\`.`,
    `- **Content hash:** \`${r.contentHash}\`, checked against the hash ${host} published, over the package as published.`,
    `- **Files hash:** \`${r.filesHash}\`, over the files in \`${folder}/\` other than \`.registry.json\`, which records both.`,
    `- **The folder it replaces** was checked first: \`${folder}/\` on the default branch held release \`${from.version}\` as its record says, file for file.`,
    ...(source ? [`- **Source at that commit:** ${source}`] : []),
    `- ${floorLine(floor)}`,
    ...(leftOut ? [`- ${leftOut}`] : []),
    ...(input.yanked
      ? ["- **Withdrawn by its publisher.** An admin proposed it anyway. The reason is with the claims below."]
      : []),
  ];

  const runs = input.runs
    ? input.runs
        .map((g) => ({ label: g.label, count: g.files.length + g.more }))
        .filter((g) => g.count > 0)
        .map((g) => `\`${g.label}\` (${g.count} ${g.count === 1 ? "file" : "files"})`)
    : [];
  const willRun = [
    "- **Before you merge:** this repository's checks, on this pull request. The build runs the registry " +
      `generator, which checks the ${label}. Nothing else has run it.`,
    `- **When you merge:** ${mergeLine(input.host, migrations.added.length)}`,
    carriesOver(r.kind),
    r.kind === "theme"
      ? "- **Code:** none. A theme is CSS and assets."
      : runs.length > 0
        ? `- **Code it runs:** ${runs.join(", ")}.`
        : "- **Code it runs:** none found.",
  ];

  const claims = [
    claimLine("name", input.claims.name),
    ...(input.claims.publisher ? [claimLine("publisher", input.claims.publisher)] : []),
    ...input.claims.permissions.slice(0, MAX_CLAIMS).map((p) => claimLine("permission", `${p.scope} - ${p.reason}`)),
    ...(input.claims.permissions.length > MAX_CLAIMS
      ? [`and ${input.claims.permissions.length - MAX_CLAIMS} more permissions`]
      : []),
    ...(floor.declared && !PLAIN_VERSION.test(floor.declared) ? [claimLine("requires MixOS", floor.declared)] : []),
    ...(input.yanked ? [claimLine("withdrawn", input.yanked.reason ?? "no reason given")] : []),
    ...(input.declarations ?? []).flatMap((row) => [
      ...(row.added.length > 0 ? [claimLine(`${row.label.toLowerCase()} adds`, row.added.join(", "))] : []),
      ...(row.removed.length > 0 ? [claimLine(`${row.label.toLowerCase()} drops`, row.removed.join(", "))] : []),
    ]),
  ];

  const body = [
    `Updates the ${label} \`${r.slug}\` from ${from.version} to ${r.version} from ${host}: the tree replaces \`${folder}/\`. ` +
      "An admin proposed it from MixOS, through the GitHub App. Nothing in it has run yet.",
    "",
    "### What changes",
    "",
    ...whatChanges,
    "",
    "### What was verified",
    "",
    ...verified,
    "",
    "### What will run, and when",
    "",
    ...willRun,
    "",
    "### Rolling back",
    "",
    rollbackLine(r.kind),
    "",
    "### The publisher's claims",
    "",
    `As the publisher wrote them on ${host}, and as the manifest declares them. MixOS doesn't check the claims: the ` +
      `${label}'s own manifest is what it enforces.`,
    "",
    fenced(claims),
    "",
  ].join("\n");
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 20)}\n\n(cut short)\n` : body;
}

/* -------------------------------------------------------------------------- */
/*  A removal                                                                   */
/* -------------------------------------------------------------------------- */

export interface RemovalBodyInput {
  /** The release the folder holds, from its record on the default branch. */
  record: Pick<InstallRecord, "source" | "kind" | "slug" | "version" | "gitTag" | "commitSha" | "contentHash" | "filesHash">;
  /** The files the tree deletes, `.registry.json` included. */
  fileCount: number;
  /** What to know first: an app that uses it optionally, or the applied theme. */
  warnings: RemovalNote[];
  /** What the manifest calls it: the publisher's words. */
  claims: { name: string };
  host: Host;
}

/** A warning in this instance's words, naming apps by slug only. */
function warningLine(note: RemovalNote): string | null {
  switch (note.code) {
    case "optional-for":
      return `- **Optional for** ${note.apps.map((a) => `\`apps/${a.slug}\``).join(", ")}: the parts that use it stop working, and the rest keeps working.`;
    case "applied-theme":
      return "- **The applied theme.** An instance that applies it shows the first theme by name once the removal is deployed there, until an admin applies another.";
    default:
      return null;
  }
}

/** The pull request's body for a removal. */
export function removalProposalBody(input: RemovalBodyInput): string {
  const { record: r } = input;
  const label = KIND_LABEL[r.kind].one.toLowerCase();
  const folder = extensionFolder(r.kind, r.slug);
  const host = sourceHost(r.source);
  const warnings = input.warnings.map(warningLine).filter((l): l is string => l !== null);

  const goes = [
    `- **The folder:** \`${folder}/\`, ${plural(input.fileCount, "file")}, \`.registry.json\` included.`,
    `- **What it held:** release \`${r.version}\`${r.gitTag ? ` (tag \`${r.gitTag}\`)` : ""} from ${host}, commit \`${r.commitSha}\`, ` +
      `content hash \`${r.contentHash}\`, files hash \`${r.filesHash}\`. The folder was checked against that release, file for file, before this was proposed.`,
    ...warnings,
  ];
  const stays = [
    `- ${KEPT_DATA[r.kind]}` +
      (r.kind === "app"
        ? " After the merge deploys, Admin > Apps lists it under Not in this build, with Delete data."
        : r.kind === "connector"
          ? " After the merge deploys, Admin > Connectors lists it under Not in this build, with Delete data."
          : ""),
  ];
  const willRun = [
    "- **Before you merge:** this repository's checks, on this pull request. The build runs the registry generator without it.",
    `- **When you merge:** ${mergeLine(input.host, 0)} The release step marks it missing and deletes nothing.`,
  ];

  const body = [
    `Removes the ${label} \`${r.slug}\`: the tree deletes \`${folder}/\`. An admin proposed it from MixOS, through the GitHub App.`,
    "",
    "### What goes",
    "",
    ...goes,
    "",
    "### What stays",
    "",
    ...stays,
    "",
    "### What will run, and when",
    "",
    ...willRun,
    "",
    "### Rolling back",
    "",
    "Revert the merge and deploy again, or redeploy the previous build on your host. Nothing was deleted from any database, so it is all there when the code returns.",
    "",
    "### What the manifest called it",
    "",
    `As its publisher wrote it on ${host}.`,
    "",
    fenced([claimLine("name", input.claims.name)]),
    "",
  ].join("\n");
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 20)}\n\n(cut short)\n` : body;
}
