/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renames an extension in this checkout, and records it so every instance's
 * data follows.
 *
 *   npm run rename -- app/wall-e                        # mints an id: wall-e-3f9a2c1b
 *   npm run rename -- app/wall-e --to wall-e-3f9a2c1b   # the slug mixos.org minted for it
 *   npm run rename -- theme/mixos-dark --dry-run        # say what it would do
 *
 * A slug is an extension's name everywhere, so a folder renamed by hand is a
 * new extension to every instance: the old slug keeps its grants, settings,
 * tables and credentials, and the new one arrives with none. This does the
 * rename the other way:
 *
 *   1. moves the folder to the new slug;
 *   2. rewrites what it can recognise as naming the old one: an app's own
 *      `callAppRoute("<slug>"…)`, `createAppClient<"<slug>">`, `createAppClient("<slug>")`
 *      and `@apps/<slug>/` imports; a connector's `name`; and in the other local
 *      apps, the manifest fields that name it (`consumes`, `listensTo`,
 *      `provides`/`emits` consumers, `connectors`, `optionalConnectors`, MCP
 *      `sources`) and `context.services.request("<slug>"…)`,
 *      `context.connectors["<name>"]` or `context.connectors.<name>`;
 *   3. lists every other place the old slug appears quoted or in a path, for a
 *      person to look at;
 *   4. adds the rename to the ledger, extension-renames.json, which the release
 *      step reads to move each instance's data (scripts/extension-renames.ts,
 *      scripts/sync-renames.ts).
 *
 * It never edits a `remixedFrom` entry, which records the past (apps/AGENTS.md
 * invariant 32), nor anything installed from a Registry. It refuses to rename
 * an installed extension: its slug is its publisher's, and its install record
 * names it. Delete its `.registry.json` to make it your own first.
 *
 * The new slug ends in an id (src/lib/extensions/slug-id.ts). mixos.org mints
 * one the first time an extension is listed; pass it as `--to` so your copy has
 * the name an install gets.
 *
 * Writes files only; it commits nothing. Run `npm run registry` after it, and
 * commit the result.
 */

import fs from "node:fs";
import path from "node:path";
import { hasSlugId, withSlugId } from "../src/lib/extensions/slug-id";
import { INSTALL_RECORD_FILE } from "../src/lib/repository/install-record";
import {
  RENAMES_FILE,
  RENAME_KINDS,
  readRenames,
  serializeRenames,
  slugProblem,
  type RenameKind,
} from "./extension-renames";

const KIND_DIR: Record<RenameKind, string> = { app: "apps", connector: "connectors", theme: "themes" };

/** The source files an app's code is in. */
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** Folders never searched for leftovers: generated, installed, or history. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".next", ".mixos", "generated", "plans", "dist", "ops"]);

/** Files searched for leftovers. */
const TEXT = /\.(?:[cm]?[jt]sx?|json|md|css|mjs|cjs|ya?ml|sql|html|svg)$/;

export class RenameError extends Error {}

export interface RenameOptions {
  root: string;
  kind: RenameKind;
  slug: string;
  /** The new slug; minted when absent. */
  to?: string;
  /** `YYYY-MM-DD`, for the ledger. Today by default. */
  today?: string;
  /** Plan it and change nothing. */
  dryRun?: boolean;
}

export interface Rewrite {
  /** Repo-relative, as it is after the rename. */
  file: string;
  /** How many places in it were rewritten. */
  count: number;
}

export interface Leftover {
  file: string;
  line: number;
  text: string;
}

export interface RenameReport {
  kind: RenameKind;
  from: string;
  to: string;
  rewrites: Rewrite[];
  leftovers: Leftover[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace every match of `pattern` with `replace`, counting them. */
function replaceAll(text: string, pattern: RegExp, replace: (m: RegExpExecArray) => string): [string, number] {
  let count = 0;
  const out = text.replace(pattern, (...args) => {
    count++;
    const m = args.slice(0, -2) as unknown as RegExpExecArray;
    return replace(m);
  });
  return [out, count];
}

/** An app's own code naming its slug: the forms MixOS checks against its folder. */
function ownSlugRewrites(text: string, from: string, to: string): [string, number] {
  const f = escape(from);
  let total = 0;
  const steps: RegExp[] = [
    new RegExp(`(\\bcallAppRoute\\s*(?:<[^<>]*>)?\\s*\\(\\s*)(["'\`])${f}\\2`, "g"),
    new RegExp(`(\\bcreateAppClient\\s*<\\s*)(["'])${f}\\2(?=\\s*>)`, "g"),
    new RegExp(`(\\bcreateAppClient\\s*(?:<[^<>]*>)?\\s*\\(\\s*)(["'\`])${f}\\2`, "g"),
  ];
  for (const re of steps) {
    const [next, n] = replaceAll(text, re, (m) => `${m[1]}${m[2]}${to}${m[2]}`);
    text = next;
    total += n;
  }
  const [next, n] = replaceAll(text, new RegExp(`(["'\`])@apps/${f}(?=[/"'\`])`, "g"), (m) => `${m[1]}@apps/${to}`);
  return [next, total + n];
}

/** Another app's code naming the renamed app or connector. */
function consumerRewrites(text: string, kind: RenameKind, from: string, to: string): [string, number] {
  const f = escape(from);
  if (kind === "app") {
    return replaceAll(
      text,
      new RegExp(`(\\bservices\\.request\\s*\\(\\s*)(["'\`])${f}\\2`, "g"),
      (m) => `${m[1]}${m[2]}${to}${m[2]}`,
    );
  }
  if (kind !== "connector") return [text, 0];
  let total = 0;
  let [next, n] = replaceAll(
    text,
    new RegExp(`(\\bconnectors\\s*\\[\\s*)(["'\`])${f}\\2(?=\\s*\\])`, "g"),
    (m) => `${m[1]}${m[2]}${to}${m[2]}`,
  );
  total += n;
  // `.from` only reads as a property when the name is an identifier; the new
  // name has a hyphen before its id, so it is written as an index.
  if (/^[A-Za-z_$][\w$]*$/.test(from)) {
    [next, n] = replaceAll(next, new RegExp(`(\\bconnectors)\\.${f}\\b`, "g"), (m) => `${m[1]}["${to}"]`);
    total += n;
  }
  return [next, total];
}

/** The fields of another app's manifest that name the renamed extension. Never `remixedFrom`. */
function manifestRewrites(manifest: Record<string, unknown>, kind: RenameKind, from: string, to: string): number {
  let count = 0;
  const swap = (v: unknown) => {
    if (v === from) {
      count++;
      return to;
    }
    return v;
  };
  const each = (key: string, fn: (entry: Record<string, unknown>) => void) => {
    const list = manifest[key];
    if (Array.isArray(list)) for (const entry of list) if (entry && typeof entry === "object") fn(entry as Record<string, unknown>);
  };
  if (kind === "app") {
    each("consumes", (e) => (e.app = swap(e.app)));
    each("listensTo", (e) => (e.app = swap(e.app)));
    for (const key of ["provides", "emits"]) {
      each(key, (e) => {
        if (Array.isArray(e.consumers)) e.consumers = e.consumers.map(swap);
      });
    }
  }
  if (kind === "connector") {
    each("connectors", (e) => (e.name = swap(e.name)));
    each("optionalConnectors", (e) => (e.name = swap(e.name)));
    each("mcp", (e) => {
      if (Array.isArray(e.sources)) e.sources = e.sources.map(swap);
    });
  }
  return count;
}

function listFiles(dir: string, keep: RegExp, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) listFiles(abs, keep, out);
    } else if (keep.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/** The other local apps: folders under apps/ with an app.json, no install record, and not templates. */
function localApps(root: string, except: string): string[] {
  const apps = path.join(root, "apps");
  if (!fs.existsSync(apps)) return [];
  return fs
    .readdirSync(apps, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name) && d.name !== except)
    .map((d) => path.join(apps, d.name))
    .filter((dir) => fs.existsSync(path.join(dir, "app.json")) && !fs.existsSync(path.join(dir, INSTALL_RECORD_FILE)));
}

/** Rename `kind`/`slug` in the checkout at `root`. Throws RenameError, having changed nothing, when it can't. */
export function renameExtension(opts: RenameOptions): RenameReport {
  const { root, kind, slug } = opts;
  if (!RENAME_KINDS.includes(kind)) throw new RenameError(`"${kind}" is not app, connector or theme.`);
  const kindDir = KIND_DIR[kind];
  const fromDir = path.join(root, kindDir, slug);
  const where = `${kindDir}/${slug}`;

  if (/^[_.]/.test(slug)) throw new RenameError(`${where} is a template or set aside, not an extension: nothing to rename.`);
  if (!fs.existsSync(fromDir) || !fs.statSync(fromDir).isDirectory()) {
    throw new RenameError(`There is no ${where} in this checkout.`);
  }
  if (fs.existsSync(path.join(fromDir, INSTALL_RECORD_FILE))) {
    throw new RenameError(
      `${where} was installed from a Registry: its slug is its publisher's, and its ${INSTALL_RECORD_FILE} names it. ` +
        `To make it your own, delete its ${INSTALL_RECORD_FILE} first; every instance then treats it as a different extension.`,
    );
  }

  let to = opts.to;
  if (to === undefined) {
    if (hasSlugId(slug)) {
      throw new RenameError(`${where} already ends in an id. Pass --to <new-slug> to rename it anyway.`);
    }
    to = withSlugId(slug);
  }
  const problem = slugProblem(kind, to);
  if (problem) throw new RenameError(problem);
  if (!hasSlugId(to)) {
    throw new RenameError(`"${to}" doesn't end in an id, eight hex characters like "${withSlugId(slug)}".`);
  }
  if (to === slug) throw new RenameError(`${where} is already called ${to}.`);
  if (fs.existsSync(path.join(root, kindDir, to))) throw new RenameError(`${kindDir}/${to} already exists.`);

  const renames = readRenames(root);
  if (renames.some((r) => r.kind === kind && r.from === to)) {
    throw new RenameError(`${to} was renamed away before, in ${RENAMES_FILE}: a slug moves once.`);
  }

  // Everything is worked out first, from the files as they are, and written
  // only once all of it is known.
  const writes = new Map<string, string>();
  const rewrites: Rewrite[] = [];
  const toDir = path.join(root, kindDir, to);
  const relAfter = (abs: string) =>
    path.relative(root, abs.startsWith(fromDir + path.sep) ? path.join(toDir, path.relative(fromDir, abs)) : abs);
  const note = (abs: string, text: string, count: number) => {
    if (count === 0) return;
    writes.set(abs, text);
    rewrites.push({ file: relAfter(abs), count });
  };

  if (kind === "app") {
    for (const file of listFiles(fromDir, SOURCE)) {
      const [text, count] = ownSlugRewrites(fs.readFileSync(file, "utf-8"), slug, to);
      note(file, text, count);
    }
  }
  if (kind === "connector") {
    const file = path.join(fromDir, "connector.json");
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      if (manifest.name === slug) {
        manifest.name = to;
        note(file, `${JSON.stringify(manifest, null, 2)}\n`, 1);
      }
    }
  }
  if (kind !== "theme") {
    for (const app of localApps(root, kind === "app" ? slug : "")) {
      const manifestFile = path.join(app, "app.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as Record<string, unknown>;
      const count = manifestRewrites(manifest, kind, slug, to);
      note(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, count);
      for (const file of listFiles(app, SOURCE)) {
        const [text, n] = consumerRewrites(fs.readFileSync(file, "utf-8"), kind, slug, to);
        note(file, text, n);
      }
    }
  }

  // What's left: the old slug quoted, or as a path segment, anywhere a person
  // keeps code or docs. Read from what the files will be.
  const leftovers: Leftover[] = [];
  const mention = new RegExp(`(?<=["'\`/])${escape(slug)}(?=["'\`/])`);
  for (const top of ["apps", "connectors", "themes", "src", "scripts", "docs", "eslint-rules", "public"]) {
    for (const file of listFiles(path.join(root, top), TEXT)) {
      if (path.basename(file) === RENAMES_FILE) continue;
      const text = writes.get(file) ?? fs.readFileSync(file, "utf-8");
      if (!mention.test(text)) continue;
      text.split("\n").forEach((line, i) => {
        if (mention.test(line)) leftovers.push({ file: relAfter(file), line: i + 1, text: line.trim().slice(0, 160) });
      });
    }
  }

  const report: RenameReport = { kind, from: slug, to, rewrites, leftovers };
  if (opts.dryRun) return report;

  fs.renameSync(fromDir, toDir);
  for (const [abs, text] of writes) {
    const target = abs.startsWith(fromDir + path.sep) ? path.join(toDir, path.relative(fromDir, abs)) : abs;
    fs.writeFileSync(target, text, "utf-8");
  }
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(root, RENAMES_FILE),
    serializeRenames([...renames, { kind, from: slug, to, date: today }]),
    "utf-8",
  );
  return report;
}

function main(): void {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--to");
  const toAt = args.indexOf("--to");
  const to = toAt === -1 ? undefined : args[toAt + 1];
  const dryRun = args.includes("--dry-run");
  const m = target ? /^(app|connector|theme)\/([^/]+)$/.exec(target) : null;
  if (!m || (toAt !== -1 && !to)) {
    console.error("Usage: npm run rename -- <app|connector|theme>/<slug> [--to <new-slug>] [--dry-run]");
    process.exit(2);
  }
  const kind = m[1] as RenameKind;
  let report: RenameReport;
  try {
    report = renameExtension({ root: path.resolve(__dirname, ".."), kind, slug: m[2], to, dryRun });
  } catch (err) {
    if (err instanceof RenameError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const dir = KIND_DIR[kind];
  console.log(`${dryRun ? "Would rename" : "Renamed"} ${dir}/${report.from} to ${dir}/${report.to}.`);
  for (const r of report.rewrites) console.log(`  rewrote ${r.file} (${r.count})`);
  if (report.leftovers.length > 0) {
    console.log(`\nStill naming "${report.from}" (look at each; some may be right as they are):`);
    for (const l of report.leftovers.slice(0, 40)) console.log(`  ${l.file}:${l.line}  ${l.text}`);
    if (report.leftovers.length > 40) console.log(`  …and ${report.leftovers.length - 40} more`);
  }
  if (dryRun) return;
  console.log(`\nAdded it to ${RENAMES_FILE}. Next:`);
  console.log("  npm run registry      check the build, the ledger included");
  console.log("  commit the result     the release step then moves each instance's data to the new slug");
  if (kind === "connector") {
    console.log(
      `\nIts OAuth redirect URI and webhook URL name it: register /api/connectors/${report.to}/oauth/callback ` +
        `and /api/webhooks/${report.to} with the provider in place of the old ones.`,
    );
  }
}

if (require.main === module) main();
