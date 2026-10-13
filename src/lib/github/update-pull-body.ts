/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The body of a MixOS update's pull request: what GitHub confirmed about the
 * release, its numbers against the default branch, the upgrade checklist, and
 * the release notes.
 *
 * ── WHOSE WORDS ─────────────────────────────────────────────────────────────
 *
 * Everything but the last section is this instance's: fixed text, the
 * validated tag and commit, GitHub's own numbers, and two links built here
 * from the tag (the release's page on mixos.org and the upgrade guide). The
 * notes are mixos.org's, made from commit subjects, so they get the treatment
 * the notice gives them (D30) and the one a proposal gives a publisher's
 * claims (./pull-body.ts): plain text, one line each, images and HTML dropped,
 * every link shown as its text and then its address, inside a fenced block
 * longer than any run of backticks in them, with `\`, `[`, `]`, `@` and `#`
 * escaped so nothing in them can mention, link or close an issue even if the
 * text is ever rendered outside the fence.
 *
 * Pure: ./update-pull.ts gives it what it says.
 */

import { UPSTREAM_REPOSITORY } from "./identifiers";
import type { UpdateCompare } from "./outcomes";
import { fenced, inert, mergeLine, type Host } from "./pull-body";

export interface UpdateBodyInput {
  tag: string;
  commitSha: string;
  publishedAt: string;
  /** The notes as mixos.org published them: untrusted Markdown. */
  notes: string;
  /** This build's version. */
  current: string;
  /** `owner/name`. */
  repository: string;
  defaultBranch: string;
  /** GitHub's compare of the default branch with the release's commit. */
  compare: UpdateCompare;
  /** Platform migrations the release adds or changes, from that compare's files. */
  migrations: number;
  host: Host;
  releaseUrl: string;
  upgradeUrl: string;
}

/** Each line of the notes is cut here. */
const MAX_NOTE_LINE_CHARS = 500;
/** Lines of the notes shown; the rest are counted. */
const MAX_NOTE_LINES = 400;
/** The notes' characters, in all. The list caps them at 20 KB. */
const MAX_NOTE_CHARS = 24_000;
/** GitHub takes up to 65,536 characters; this stays well inside it. */
export const MAX_BODY_CHARS = 60_000;

/** The schemes an address is shown for, as the notice shows them. */
const SHOWN_SCHEME = /^(https?|mailto)$/i;

/**
 * An address worth printing after a link's text: http(s), mailto, or a path
 * with no scheme. Anything else (`javascript:`, `data:`, a place on the page)
 * is left out, and the link keeps only its text. Printed, never followed.
 */
export function shownAddress(url: string): string | null {
  const address = url.trim();
  if (address === "" || address.startsWith("#")) return null;
  const colon = address.indexOf(":");
  const slash = address.indexOf("/");
  const question = address.indexOf("?");
  const hash = address.indexOf("#");
  const relative =
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash);
  return relative || SHOWN_SCHEME.test(address.slice(0, colon)) ? address : null;
}

/** Whether printing `address` after `text` would say the same thing twice. */
function sameAddress(text: string, address: string): boolean {
  return [text, `mailto:${text}`, `http://${text}`, `https://${text}`].includes(address);
}

/** `text`, then its address in brackets when it adds something. */
function linkAsText(text: string, url: string): string {
  const address = shownAddress(url);
  const shown = text.trim();
  if (!address || sameAddress(shown, address)) return shown;
  return shown ? `${shown} (${address})` : `(${address})`;
}

/** A link's destination: no whitespace, and parentheses only in balanced pairs. */
const DESTINATION = String.raw`(?:[^()\s<>]|\([^()\s]*\))*`;
const TITLE = String.raw`(?:\s+(?:"[^"]*"|'[^']*'))?`;

/**
 * The notes as plain text, one line each. Exported for its tests: the cases
 * are the notice's (src/components/admin/release-notice.test.ts).
 */
export function notesAsText(markdown: string): string[] {
  // Reference definitions (`[ref]: https://…`) are read, then dropped.
  const definitions = new Map<string, string>();
  const kept: string[] = [];
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const definition = /^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.exec(raw);
    if (definition) {
      definitions.set(definition[1].trim().toLowerCase(), definition[2]);
      continue;
    }
    kept.push(raw);
  }
  const defined = (label: string) => definitions.get(label.trim().toLowerCase());

  const text = kept
    .join("\n")
    // Autolinks first, before anything in angle brackets is read as a tag.
    .replace(/<(https?:\/\/[^\s<>]+)>/g, "$1")
    .replace(/<mailto:([^\s<>]+)>/g, "$1")
    .replace(/<([^\s<>@]+@[^\s<>]+)>/g, "$1")
    // Scripts and styles go whole; any other tag goes, and its text stays.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?[A-Za-z][^<>]*>/g, "")
    // Images are dropped, inline and by reference.
    .replace(new RegExp(String.raw`!\[[^\]]*\]\(\s*<?${DESTINATION}>?${TITLE}\s*\)`, "g"), "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    // Links become their text, then their address.
    .replace(new RegExp(String.raw`\[([^\]]*)\]\(\s*<?(${DESTINATION})>?${TITLE}\s*\)`, "g"), (_, t: string, url: string) =>
      linkAsText(t, url),
    )
    .replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (whole: string, t: string, label: string) => {
      const url = defined(label === "" ? t : label);
      return url === undefined ? whole : linkAsText(t, url);
    })
    .replace(/\[([^\]]+)\]/g, (whole: string, t: string) => {
      const url = defined(t);
      return url === undefined ? whole : linkAsText(t, url);
    });

  const lines: string[] = [];
  let blank = true;
  for (const raw of text.split("\n")) {
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    const flat = (heading ? heading[1] : raw).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+$/, "");
    if (flat.trim() === "") {
      if (!blank) lines.push("");
      blank = true;
      continue;
    }
    blank = false;
    const capped = flat.length > MAX_NOTE_LINE_CHARS ? `${flat.slice(0, MAX_NOTE_LINE_CHARS - 1)}…` : flat;
    lines.push(inert(capped));
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += lines[i].length + 1;
    if (i >= MAX_NOTE_LINES || total > MAX_NOTE_CHARS) {
      return [...lines.slice(0, i), `(cut short: ${lines.length - i} more lines)`];
    }
  }
  return lines;
}

/** The pull request's body. */
export function updateBody(input: UpdateBodyInput): string {
  const { tag, compare, defaultBranch } = input;
  const upstream = `${UPSTREAM_REPOSITORY.owner}/${UPSTREAM_REPOSITORY.name}`;
  const short = input.commitSha.slice(0, 12);
  const published = /^\d{4}-\d{2}-\d{2}/.exec(input.publishedAt)?.[0] ?? null;
  const n = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;
  const notes = notesAsText(input.notes);

  const verified = [
    `- **Release:** \`${tag}\`${published ? `, published ${published}` : ""}, at commit \`${input.commitSha}\` on ${upstream}.`,
    `- **Confirmed on GitHub:** ${upstream}'s tag \`${tag}\` is at that commit, and the commit is on its \`${UPSTREAM_REPOSITORY.defaultBranch}\`. ` +
      "The branch is at that commit, with nothing added: no commit of the App's.",
    `- **Against \`${defaultBranch}\`:** ${n(compare.ahead, "commit")} ahead, ${n(compare.behind, "commit")} behind, ` +
      `${n(compare.files, "file")} changed, as GitHub compares \`${defaultBranch}\` with \`${short}\`.`,
    "- **Workflows:** none changed. The App can't push a change to `.github/workflows/`, and refuses a release that makes one.",
    `- **Platform migrations:** ${input.migrations === 0 ? "none." : `${n(input.migrations, "file")} under \`supabase/migrations/\`. They only go forward.`}`,
  ];

  const checklist = [
    "1. **Back up the database first.** Migrations only go forward, so a backup is the way back.",
    "2. **Read the notes below, breaking changes first,** against your apps and your own changes.",
    `   - The release's page: ${input.releaseUrl}`,
    `   - How to upgrade: ${input.upgradeUrl}`,
    "3. **Let the checks run.** On a new fork, GitHub keeps workflows off until you turn them on under Actions. " +
      "Don't merge it unchecked.",
    `4. **When you merge:** ${mergeLine(input.host, input.migrations)}`,
  ];

  const body = [
    `Updates MixOS to ${tag}. This instance runs ${input.current}. An admin opened it from MixOS, through the GitHub App. ` +
      "Nothing here merges: merging it is the deploy.",
    "",
    "### What was verified",
    "",
    ...verified,
    "",
    "### Before you merge",
    "",
    ...checklist,
    "",
    "### Release notes",
    "",
    `As published on mixos.org, as text: addresses are shown, not linked.`,
    "",
    fenced(notes.length > 0 ? notes : ["(no notes)"]),
    "",
  ].join("\n");
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 20)}\n\n(cut short)\n` : body;
}
