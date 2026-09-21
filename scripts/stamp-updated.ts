/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stamp `lastUpdated` on every app/connector manifest the current commit touches.
 *
 *   npx tsx scripts/stamp-updated.ts              # stamp what's staged, re-stage it
 *   npx tsx scripts/stamp-updated.ts --dry-run    # report, write nothing
 *   npx tsx scripts/stamp-updated.ts --files a b  # stamp as if these paths changed
 *
 * `lastUpdated` means "this app/connector changed in this commit". It is written
 * by `.githooks/pre-commit` (and by `/mixos deploy`, which calls the same script so
 * the stamp lands in the diff you review). It replaced `/mos-publish`, which made
 * the date mean "the author ran a command" — accurate, but only when someone
 * remembered to run it, which is the failure mode this removes.
 *
 * Four rules keep the date honest:
 *
 *  - A directory is stamped when ANY file under it changed — source, migrations,
 *    README, assets, and deletions too. "Changed" is the honest claim; "changed
 *    in a way I judged significant" is not something a script can assess.
 *  - A change that touches ONLY `lastUpdated` never re-stamps, unless the date
 *    would move BACKWARDS. Without the first half, `git commit --amend` and any
 *    re-run would rewrite the date forever; without the second, a stale index
 *    could roll the date back and the guard would refuse to ever correct it.
 *  - The STAGED manifest is what gets stamped, never the working-tree copy —
 *    see stampStaged(). A hook that quietly enlarges a commit with unstaged
 *    edits is worse than a stale date.
 *  - Nothing here ever blocks a commit. A missing date is cosmetic.
 *
 * `--files` exists so the logic is testable outside a git repository, and so
 * callers that already know the changed paths don't pay for a second git call.
 * In that mode there is no index, so it writes the working-tree file directly.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = path.resolve(__dirname, "..");

/** Directories whose subdirectories are independently stampable units. */
const ROOTS = ["apps", "connectors", "themes"] as const;

interface Target {
  /** "apps" | "connectors" | "themes" */
  root: string;
  /** Directory name, which is the slug (an invariant the generator enforces). */
  slug: string;
  /** Repo-relative path to the manifest. */
  manifestRel: string;
  /**
   * True for a manifest this script must not rewrite.
   *
   * Nothing sets it today: every manifest is JSON and every one is stampable.
   * It stays because the caller still branches on it, and because the reason it
   * existed — a manifest that was code — is exactly the shape that could come
   * back.
   */
  isModule: boolean;
  /** Repo-relative paths of the changed files under this directory. */
  changed: string[];
}

/**
 * `stdio` pipes stderr rather than letting it inherit: git prints a full usage
 * dump when it is run outside a repository, and a pre-commit hook is the last
 * place that belongs. Failures surface as a thrown error with the message on it,
 * which every caller here already handles.
 */
function git(args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf-8",
    ...(input === undefined
      ? { stdio: ["ignore", "pipe", "pipe"] as const }
      : { input, stdio: ["pipe", "pipe", "pipe"] as const }),
  });
}

/**
 * Paths staged for the in-flight commit.
 *
 * Three flags carry weight here:
 *  - `core.quotePath=false` + `-z`: by default git renders a non-ASCII path as a
 *    C-quoted string (`"apps/a/na\303\257ve.txt"`), which no longer starts with
 *    `apps/` and would silently drop that app. `-z` additionally survives a
 *    newline in a filename, which no line-splitting can.
 *  - `--no-renames`: a rename reported as `R` yields only the DESTINATION under
 *    `--name-only`, so moving a file out of app A into app B would stamp B and
 *    leave A — which lost a file — untouched. Decomposing it into a delete plus
 *    an add gets both directories.
 *  - `D` in the filter: deleting a page, job, or migration is a real change to an
 *    app whose manifest is still on disk. The manifest of a directory deleted
 *    outright is caught by resolveManifest()'s existence check instead.
 */
function stagedFiles(): string[] {
  const out = git([
    "-c",
    "core.quotePath=false",
    "diff",
    "--cached",
    "-z",
    "--name-only",
    "--no-renames",
    "--diff-filter=ACMRD",
  ]);
  return out.split("\0").map((l) => l.trim()).filter(Boolean);
}

/**
 * Resolve which manifest a directory owns.
 *
 * One candidate per kind now. This used to mirror a precedence rule in
 * `loadAppManifest()` — `app.ts` over `app.json` — which existed so that
 * stamping did not write a value nothing consumes. With `app.json` the sole
 * manifest there is nothing to prefer.
 *
 * `widgets.ts` is deliberately not considered: it carries config fields, not
 * the `lastUpdated` this script stamps.
 */
function resolveManifest(
  root: string,
  slug: string,
): { rel: string; isModule: boolean } | null {
  if (root === "connectors" || root === "themes") {
    const rel =
      root === "connectors"
        ? `connectors/${slug}/connector.json`
        : `themes/${slug}/theme.json`;
    return fs.existsSync(path.join(ROOT, rel)) ? { rel, isModule: false } : null;
  }
  const jsonRel = `apps/${slug}/app.json`;
  return fs.existsSync(path.join(ROOT, jsonRel))
    ? { rel: jsonRel, isModule: false }
    : null;
}

/** Group changed paths into the app/connector directories they belong to. */
function collectTargets(changed: string[]): Target[] {
  const byDir = new Map<string, string[]>();

  for (const file of changed) {
    const parts = file.split("/");
    if (parts.length < 2) continue;
    const [root, slug] = parts;
    if (!ROOTS.includes(root as (typeof ROOTS)[number])) continue;
    // `_`-prefixed directories are templates — the same convention the registry
    // generator skips. They are scaffolding, not shippable units.
    if (slug.startsWith("_")) continue;
    // Files directly under apps/, connectors/ or themes/ (e.g. AGENTS.md) belong
    // to no app.
    if (parts.length < 3) continue;

    const key = `${root}/${slug}`;
    const list = byDir.get(key);
    if (list) list.push(file);
    else byDir.set(key, [file]);
  }

  const targets: Target[] = [];
  for (const [key, files] of byDir) {
    const [root, slug] = key.split("/");
    const manifest = resolveManifest(root, slug);
    if (!manifest) continue; // no manifest on disk — nothing to stamp
    targets.push({
      root,
      slug,
      manifestRel: manifest.rel,
      isModule: manifest.isModule,
      changed: files,
    });
  }
  return targets.sort((a, b) => a.manifestRel.localeCompare(b.manifestRel));
}

/**
 * True when the only thing this commit does to the directory is move
 * `lastUpdated` — in which case stamping again would be a no-op that still
 * rewrites the date. Compares the staged manifest against HEAD's with the field
 * stripped from both; anything else differing means there is real work to date.
 *
 * Only reachable in git mode, and only when the manifest is the sole changed
 * file. A manifest with no HEAD version is new, which is a real change.
 */
function isStampOnlyChange(target: Target): boolean {
  if (target.changed.length !== 1) return false;
  if (target.changed[0] !== target.manifestRel) return false;

  let headRaw: string;
  try {
    headRaw = git(["show", `HEAD:${target.manifestRel}`]);
  } catch {
    return false; // new file, or no HEAD yet (initial commit)
  }

  let stagedRaw: string;
  try {
    stagedRaw = git(["show", `:${target.manifestRel}`]);
  } catch {
    return false;
  }

  const stripped = (raw: string): string | null => {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      delete obj.lastUpdated;
      return JSON.stringify(obj);
    } catch {
      return null; // unparseable — treat as a real change, let the build complain
    }
  };

  const a = stripped(headRaw);
  const b = stripped(stagedRaw);
  if (a === null || b === null || a !== b) return false;

  // Everything but the date matches — but WHICH WAY the date moved decides
  // whether skipping is safe. A pathspec-limited commit (`git commit -- <path>`)
  // runs this hook against a temporary index, so the stamp reaches the commit
  // while the real index keeps the pre-stamp blob. The next commit then arrives
  // carrying a date OLDER than HEAD's. Treating that as a no-op would ship the
  // regression and leave the manifest permanently dirty, with the guard
  // refusing to correct it on every subsequent commit. Only an unchanged or
  // forward-moving date is genuinely nothing to do; a backward one gets
  // re-stamped, which heals the index.
  const headAt = Date.parse(readLastUpdated(headRaw) ?? "");
  const stagedAt = Date.parse(readLastUpdated(stagedRaw) ?? "");
  if (Number.isFinite(headAt) && Number.isFinite(stagedAt) && stagedAt < headAt) {
    return false;
  }
  return true;
}

/** The raw `lastUpdated` string on a manifest blob, if it has a usable one. */
function readLastUpdated(raw: string): string | null {
  try {
    const v = (JSON.parse(raw) as Record<string, unknown>).lastUpdated;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Apply `lastUpdated` to manifest text, preserving key order and appending the
 *  field when new — the diff stays one line instead of a whole-file reshuffle.
 *  Two-space indent matches every other manifest in the repo. */
function withStamp(raw: string, at: string): string {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify({ ...obj, lastUpdated: at }, null, 2) + "\n";
}

/** The index's blob for a path, or null when the path isn't tracked yet. */
function stagedBlob(manifestRel: string): string | null {
  try {
    return git(["show", `:${manifestRel}`]);
  } catch {
    return null;
  }
}

/**
 * Stamp the manifest **as it is staged**, not as it sits in the working tree.
 *
 * This distinction is the whole point. Rewriting the working-tree file and then
 * `git add`-ing it would stage every unstaged edit in that manifest as a side
 * effect: a half-finished `roles` or `connectors` change, or the hunks a
 * developer deliberately withheld with `git add -p`, would ride into the commit
 * silently — and `git status` would come back clean afterwards, destroying the
 * evidence. A hook that quietly enlarges a commit is worse than a stale date.
 *
 * So the staged blob is stamped and written straight into the index. The working
 * tree is only updated when it is byte-identical to what was staged, which is
 * the ordinary case and keeps the file from showing as permanently modified.
 * When they differ, the developer's work is left exactly as they left it and the
 * divergence is reported.
 *
 * Returns true when working-tree edits were preserved rather than followed.
 */
function stampStaged(target: Target, at: string): boolean {
  const abs = path.join(ROOT, target.manifestRel);
  const staged = stagedBlob(target.manifestRel);

  // Untracked (a brand-new manifest not yet added): nothing in the index to
  // stamp, so the working tree IS the content, and `git add` is the way in.
  if (staged === null) {
    fs.writeFileSync(abs, withStamp(fs.readFileSync(abs, "utf-8"), at), "utf-8");
    git(["add", "--", target.manifestRel]);
    return false;
  }

  const next = withStamp(staged, at);

  // Write the stamped blob into the index directly. `update-index --cacheinfo`
  // reuses the path's existing mode so an executable bit or symlink entry is not
  // rewritten as a plain file.
  const sha = git(["hash-object", "-w", "--stdin"], next).trim();
  const mode = git(["ls-files", "-s", "--", target.manifestRel]).trim().split(/\s+/)[0] || "100644";
  git(["update-index", "--cacheinfo", `${mode},${sha},${target.manifestRel}`]);

  const worktree = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
  if (worktree === staged) {
    fs.writeFileSync(abs, next, "utf-8");
    return false;
  }
  return true;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const filesIdx = argv.indexOf("--files");
  const explicit = filesIdx !== -1 ? argv.slice(filesIdx + 1) : null;
  const gitMode = explicit === null;

  let changed: string[];
  if (explicit) {
    changed = explicit.filter((f) => !f.startsWith("--"));
  } else {
    try {
      changed = stagedFiles();
    } catch (err) {
      // Not a git repo, or git unavailable. Nothing to stamp, and refusing to
      // guess is better than stamping the whole tree.
      console.error(
        `[stamp] could not read staged files (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — nothing stamped.`,
      );
      process.exit(0);
    }
  }

  const targets = collectTargets(changed);
  if (targets.length === 0) return;

  // One timestamp for the whole commit: two apps changed by the same commit
  // should carry the same date, not dates milliseconds apart.
  const now = new Date().toISOString();

  const stamped: string[] = [];
  const skipped: string[] = [];
  const manual: Target[] = [];
  const preservedWip: string[] = [];

  for (const target of targets) {
    if (target.isModule) {
      manual.push(target);
      continue;
    }
    if (gitMode && isStampOnlyChange(target)) {
      skipped.push(`${target.slug} (only lastUpdated changed)`);
      continue;
    }
    if (!dryRun) {
      if (gitMode) {
        // Stamps the staged blob and writes it to the index — see stampStaged().
        if (stampStaged(target, now)) preservedWip.push(target.manifestRel);
      } else {
        const abs = path.join(ROOT, target.manifestRel);
        fs.writeFileSync(abs, withStamp(fs.readFileSync(abs, "utf-8"), now), "utf-8");
      }
    }
    stamped.push(target.manifestRel);
  }

  const prefix = dryRun ? "[stamp:dry-run]" : "[stamp]";
  if (stamped.length) {
    console.log(`${prefix} lastUpdated → ${now}`);
    for (const rel of stamped) console.log(`${prefix}   ${rel}`);
  }
  for (const note of skipped) console.log(`${prefix} skipped ${note}`);

  // The stamp went into the commit; the working-tree copy still holds edits that
  // were never staged. Say so, because the manifest will read as modified
  // afterwards and that would otherwise look like the hook misfired.
  for (const rel of preservedWip) {
    console.log(
      `${prefix} ${rel} has unstaged edits — stamped the staged version only, ` +
        `your working copy is untouched.`,
    );
  }

  // A TS manifest is never rewritten: a bad edit to arbitrary TypeScript breaks
  // the build for everyone. Warn loudly and let the commit through — the same
  // "checks warn, they don't block" stance /mixos deploy takes everywhere else.
  for (const target of manual) {
    console.warn(
      `\n${prefix} ${target.manifestRel} is a TypeScript manifest — not stamped.\n` +
        `${prefix} Add or update this line in its default export:\n\n` +
        `      lastUpdated: "${now}",\n`,
    );
  }
}

try {
  main();
} catch (err) {
  // Never fail the commit over the stamp. A missing date is a cosmetic problem;
  // a pre-commit hook that blocks work over one is not.
  console.error("[stamp] failed (commit not blocked):", err);
  process.exit(0);
}
