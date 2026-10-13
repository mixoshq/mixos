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
 * Pure: ./propose.ts gives it what it says.
 */

import type { FloorVerdict } from "@/lib/platform/version-floor";
import { leftOutLine, type LeftOut } from "@/lib/repository/left-out";
import { recordSourceUrl, type InstallRecord } from "@/lib/repository/install-record";
import { sourceHost } from "@/lib/repository/provenance";
import type { RunGroup } from "@/lib/repository/review";
import { KIND_LABEL } from "@/lib/repository/types";
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
 * `text` with `\`, `[`, `]`, `@` and `#` escaped: inert as Markdown even
 * outside a fence, where they could open a link, a mention or an issue
 * reference. The release notes of a MixOS update go through this too
 * (./update-pull-body.ts).
 */
export function inert(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[[\]@#]/g, (c) => `\\${c}`);
}

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
  return `${label}: ${inert(capped) || "(empty)"}`;
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

/** What merging does on `host`, with `migrations` to apply. Shared with the MixOS update's body. */
export function mergeLine(host: Host, migrations: number): string {
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
