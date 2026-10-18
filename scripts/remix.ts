/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The deterministic half of `/mixos remix` (.claude/skills/mixos/actions/remix.md).
// The agent reads code and talks to the developer; these two commands are the
// parts that must come out the same every time.
//
//   npx tsx scripts/remix.ts source <source-app> <target-app>
//       The moment being remixed, as JSON: the source's commit and where it was
//       taken from (decision 18 of docs/plans/20261015_2343-remix.md), whether
//       its code may be adapted or must be rebuilt (decisions 3, 4, 16), and the
//       credit every remixed file carries as a comment (decision 23): the
//       source app's name, its version, its authors and the day.
//
//   npx tsx scripts/remix.ts check <target-app>
//       What must hold at the moment of the remix, for the last entry in the
//       target's `remixedFrom`: the build checks an entry's shape forever, and
//       this checks the rest once (decision 19).

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { RemixEntrySchema, formatZodError, type RemixEntry } from "./manifest-schemas";
import {
  REMIX_KEYWORDS_MAX,
  REMIX_KEYWORDS_MIN,
  licenseVerdict,
  normalizeRemixKeyword,
  normalizeRemixKeywords,
  parseAnchor,
  type LicenseVerdict,
} from "../src/lib/apps/remix";
import {
  FolderReadError,
  folderFilesHash,
  readInstallRecord,
  recordMismatch,
} from "../src/lib/repository/install-record";

const ROOT = path.resolve(__dirname, "..");

type Source = RemixEntry["source"];

function appDir(root: string, slug: string): string {
  return path.join(root, "apps", slug);
}

function readAppJson(root: string, slug: string): Record<string, unknown> {
  const file = path.join(appDir(root, slug), "app.json");
  if (!fs.existsSync(file)) throw new Error(`apps/${slug} isn't an installed app: there is no apps/${slug}/app.json.`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  source                                                                     */
/* -------------------------------------------------------------------------- */

export interface PinnedSource {
  source: Omit<Source, "anchors">;
  license: { source: string | null; target: string | null } & LicenseVerdict;
  /** Who and what a remixed file credits. */
  credit: RemixCredit;
}

/**
 * The derivative-work credit at the top of every file a remix lands in: the
 * source app's name, the version taken, its authors, and the day.
 */
export interface RemixCredit {
  name: string;
  /** The catalogue version; without one, the commit; without that, "uncommitted". */
  version: string;
  authors: string[];
  date: string;
  /** The comment's lines, without comment markers. */
  lines: string[];
}

export function creditFor(
  manifest: Record<string, unknown>,
  source: Omit<Source, "anchors">,
  license: { source: string | null; mode: "adapted" | "rebuilt" },
  date: string,
): RemixCredit {
  const name = typeof manifest.name === "string" && manifest.name ? manifest.name : source.app;
  const version = source.registry?.version ?? (source.commitSha ? `commit ${source.commitSha.slice(0, 7)}` : "uncommitted");
  const authors = Array.isArray(manifest.authors)
    ? manifest.authors.flatMap((a) => (a && typeof a === "object" && typeof a.name === "string" ? [a.name] : []))
    : [];
  const by = authors.length ? authors.join(", ") : "its authors";
  const lines = [
    `Remixed from ${name} (${source.app}) ${version}, by ${by}, on ${date}.`,
    `Derivative work: ${license.mode === "adapted" ? "adapted from its code" : "rebuilt from its remix card"}` +
      `${license.source ? `, which is ${license.source}` : ""}${source.modified ? "; taken from a locally modified copy" : ""}.`,
  ];
  return { name, version, authors, date, lines };
}

/** `lines` as a comment in `file`'s language, or null for a file that takes none (JSON). */
export function creditComment(file: string, lines: readonly string[]): string | null {
  const ext = path.extname(file).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return lines.map((l) => `// ${l}`).join("\n");
  if (ext === ".sql") return lines.map((l) => `-- ${l}`).join("\n");
  if (ext === ".css") return `/* ${lines.join("\n   ")} */`;
  if (ext === ".md") return `<!-- ${lines.join("\n     ")} -->`;
  return null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The moment being remixed. With an install record, the record's commit and
 * listing, modified when the folder no longer matches the record's files hash —
 * the check the registry generator makes. Without one, the last commit that
 * touched the folder, modified when git shows changes in it, and a null commit,
 * modified, for a folder that was never committed.
 */
export function pinSource(root: string, sourceSlug: string, targetSlug: string, date: string = today()): PinnedSource {
  if (sourceSlug === targetSlug) throw new Error("The source and the target are the same app; a remix comes from another app.");
  const sourceManifest = readAppJson(root, sourceSlug);
  const targetManifest = readAppJson(root, targetSlug);
  const dir = appDir(root, sourceSlug);

  let source: PinnedSource["source"];
  const read = readInstallRecord(dir);
  if (read.state === "ok" && recordMismatch(read.record, "app", sourceSlug) === null) {
    let modified: boolean;
    try {
      modified = folderFilesHash(dir) !== read.record.filesHash;
    } catch (err) {
      if (!(err instanceof FolderReadError)) throw err;
      modified = true;
    }
    source = {
      app: sourceSlug,
      commitSha: read.record.commitSha,
      commitFrom: "install-record",
      modified,
      registry: { origin: read.record.source, slug: read.record.slug, version: read.record.version },
    };
  } else {
    const rel = `apps/${sourceSlug}/`;
    const commit = git(root, ["log", "-1", "--format=%H", "--", rel]) || null;
    const changes = commit ? git(root, ["status", "--porcelain", "--", rel]) : null;
    source = {
      app: sourceSlug,
      commitSha: commit,
      commitFrom: "git",
      modified: commit === null || changes === null || changes.length > 0,
      registry: null,
    };
  }

  const sourceLicense = typeof sourceManifest.license === "string" ? sourceManifest.license : null;
  const targetLicense = typeof targetManifest.license === "string" ? targetManifest.license : null;
  const verdict = licenseVerdict(sourceLicense, targetLicense);
  return {
    source,
    license: { source: sourceLicense, target: targetLicense, ...verdict },
    credit: creditFor(sourceManifest, source, { source: sourceLicense, mode: verdict.mode }, date),
  };
}

/* -------------------------------------------------------------------------- */
/*  check                                                                      */
/* -------------------------------------------------------------------------- */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where `anchor` should be found in the source app, and whether it is there. */
function anchorProblem(root: string, sourceSlug: string, anchor: string): string | null {
  const parsed = parseAnchor(anchor);
  if (!parsed) return `"${anchor}" isn't an anchor.`;
  const dir = appDir(root, sourceSlug);
  const exists = (...parts: string[]) => fs.existsSync(path.join(dir, ...parts));
  switch (parsed.kind) {
    case "widget": {
      const widgets = path.join(dir, "widgets");
      const found =
        fs.existsSync(widgets) &&
        fs.readdirSync(widgets).some((f) => f.replace(/\.(tsx?|jsx?)$/, "") === parsed.id);
      return found ? null : `${anchor}: apps/${sourceSlug}/widgets/ has no widget "${parsed.id}".`;
    }
    case "page": {
      const segments = parsed.path.split("/").filter(Boolean);
      return exists("pages", ...segments, "Main.tsx") || exists("pages", ...segments, "Main.ts")
        ? null
        : `${anchor}: apps/${sourceSlug}/pages/${segments.join("/")}${segments.length ? "/" : ""}Main.tsx doesn't exist.`;
    }
    case "route": {
      const segments = parsed.path.split("/").filter(Boolean);
      const file = path.join(dir, "api", ...segments, "route.ts");
      if (!fs.existsSync(file)) return `${anchor}: apps/${sourceSlug}/api/${segments.join("/")}${segments.length ? "/" : ""}route.ts doesn't exist.`;
      const declared = new RegExp(`export\\s+const\\s+${parsed.method}\\b`).test(fs.readFileSync(file, "utf8"));
      return declared ? null : `${anchor}: that route file declares no ${parsed.method}.`;
    }
    case "job":
      return exists("jobs", `${parsed.name}.ts`) ? null : `${anchor}: apps/${sourceSlug}/jobs/${parsed.name}.ts doesn't exist.`;
  }
}

/** Anything in `text` that reaches back into the source app (decisions 10 and 11). */
function linksBack(text: string, sourceSlug: string): string[] {
  const s = escapeRegExp(sourceSlug);
  const found: string[] = [];
  const patterns: [RegExp, string][] = [
    [new RegExp(`/apps/${s}(?=[/"'\`?#)\\s]|$)`, "m"), `a link to /apps/${sourceSlug}`],
    [new RegExp(`/api/apps/${s}(?=[/"'\`?#)\\s]|$)`, "m"), `a call to /api/apps/${sourceSlug}`],
    [new RegExp(`createAppClient\\s*(?:<[^>]*>)?\\s*\\(\\s*["'\`]${s}["'\`]`), `createAppClient("${sourceSlug}")`],
    [new RegExp(`callAppRoute\\s*\\(\\s*["'\`]${s}["'\`]`), `callAppRoute("${sourceSlug}")`],
    [new RegExp(`@apps/${s}/`), `an import from @apps/${sourceSlug}/`],
  ];
  for (const [re, what] of patterns) if (re.test(text)) found.push(what);
  return found;
}

/**
 * The checks that hold at the moment of a remix, for the target's last entry.
 * Returns every problem, so the agent can fix them in one pass; empty is good.
 */
export function checkLatestRemix(root: string, targetSlug: string): string[] {
  const manifest = readAppJson(root, targetSlug);
  const raw = Array.isArray(manifest.remixedFrom) ? manifest.remixedFrom : [];
  if (raw.length === 0) return [`apps/${targetSlug}/app.json has no remixedFrom entry to check.`];
  const index = raw.length - 1;
  const at = `remixedFrom.${index}`;

  const parsed = RemixEntrySchema.safeParse(raw[index]);
  if (!parsed.success) return [`${at} is invalid:\n${formatZodError(parsed.error)}`];
  const entry = parsed.data;
  const sourceSlug = entry.source.app;
  const problems: string[] = [];

  if (sourceSlug === targetSlug) problems.push(`${at}.source.app is this app itself.`);
  if (!fs.existsSync(path.join(appDir(root, sourceSlug), "app.json"))) {
    problems.push(`${at}.source.app "${sourceSlug}" isn't installed: there is no apps/${sourceSlug}/app.json.`);
    return problems;
  }

  // The source, as it is now, is the moment recorded.
  const pinned = pinSource(root, sourceSlug, targetSlug, entry.remixedAt);
  for (const field of ["commitSha", "commitFrom", "modified"] as const) {
    if (entry.source[field] !== pinned.source[field]) {
      problems.push(
        `${at}.source.${field} is ${JSON.stringify(entry.source[field])}, but the source is ${JSON.stringify(pinned.source[field])} now. ` +
          `Record what \`npx tsx scripts/remix.ts source ${sourceSlug} ${targetSlug}\` prints.`,
      );
    }
  }
  if (JSON.stringify(entry.source.registry) !== JSON.stringify(pinned.source.registry)) {
    problems.push(`${at}.source.registry doesn't match the source's install record.`);
  }

  // License: the verdict, and the license it was made under.
  if (entry.license.spdx !== pinned.license.source) {
    problems.push(`${at}.license.spdx is ${JSON.stringify(entry.license.spdx)}; the source declares ${JSON.stringify(pinned.license.source)}.`);
  }
  if (entry.license.mode === "adapted" && pinned.license.mode !== "adapted") {
    problems.push(`${at}.license.mode is "adapted", but the code must be rebuilt: ${pinned.license.reason}`);
  }

  // Keywords: recorded normalized, and still 2–5 once normalized.
  for (const k of entry.keywords) {
    const n = normalizeRemixKeyword(k);
    if (n === null) problems.push(`keyword "${k}" says nothing once normalized; pick a word that describes the component.`);
    else if (n !== k) problems.push(`keyword "${k}" is recorded as "${n}" once normalized; write "${n}".`);
  }
  const normalized = normalizeRemixKeywords(entry.keywords);
  if (normalized.length < REMIX_KEYWORDS_MIN || normalized.length > REMIX_KEYWORDS_MAX) {
    problems.push(`${normalized.length} distinct keyword(s) once normalized; a remix has ${REMIX_KEYWORDS_MIN}–${REMIX_KEYWORDS_MAX}.`);
  }

  // Anchors exist in the source as it is.
  for (const anchor of entry.source.anchors) {
    const problem = anchorProblem(root, sourceSlug, anchor);
    if (problem) problems.push(problem);
  }

  // Landed files exist, once each, carry the credit, and none reaches back into the source.
  const targetDir = appDir(root, targetSlug);
  if (new Set(entry.landedIn).size !== entry.landedIn.length) problems.push(`${at}.landedIn lists a file twice.`);
  for (const rel of entry.landedIn) {
    const file = path.join(targetDir, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      problems.push(`landed file apps/${targetSlug}/${rel} doesn't exist.`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    const credit = creditComment(rel, pinned.credit.lines);
    if (credit !== null && !text.includes(credit)) {
      problems.push(`apps/${targetSlug}/${rel} doesn't carry the remix credit. Put this at its top, after any license header:\n${credit}`);
    }
    for (const what of linksBack(text, sourceSlug)) {
      problems.push(`apps/${targetSlug}/${rel} has ${what}: a remix depends only on the app it lands in.`);
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/*  CLI                                                                        */
/* -------------------------------------------------------------------------- */

const USAGE = `Usage:
  npx tsx scripts/remix.ts source <source-app> <target-app>
  npx tsx scripts/remix.ts check <target-app>`;

function main(argv: string[]): number {
  const [command, ...args] = argv;
  try {
    if (command === "source" && args.length === 2) {
      console.log(JSON.stringify(pinSource(ROOT, args[0], args[1]), null, 2));
      return 0;
    }
    if (command === "check" && args.length === 1) {
      const problems = checkLatestRemix(ROOT, args[0]);
      if (problems.length === 0) {
        console.log(`apps/${args[0]}: the last remix entry checks out.`);
        return 0;
      }
      console.error(`apps/${args[0]}: the last remix entry has ${problems.length} problem(s):`);
      for (const p of problems) console.error(`  - ${p}`);
      return 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
