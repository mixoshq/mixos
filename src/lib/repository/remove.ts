/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Removing an extension's code from this checkout.
 *
 * Removing an extension has two halves. Its code is a change to the repository,
 * made in a checkout and shipped by a commit and a deploy, like installing it:
 * that is this module. Its data is in each database, and stays there: the
 * release step marks an app that left the build and keeps everything it had
 * (scripts/sync-app-registry.ts), and a connector keeps its credentials. So
 * nothing here touches a database but the audit log, and no code the extension
 * ships runs to remove it.
 *
 * Two entry points call it: `npm run remove` (scripts/remove.ts), and the
 * Remove button on Admin > Apps, Connectors and Themes (./remove-actions.ts),
 * which shows planRemoval() first.
 *
 * ── WHAT REFUSES IT ─────────────────────────────────────────────────────────
 *
 * Whatever depends on it, read from the manifests in this checkout, so an app
 * the build skips today still counts: the next build reads the same manifest.
 *
 *   - a connector that an app requires (`connectors` in its app.json), which
 *     the app can't work without;
 *   - an app whose services another app uses (`consumes`), or whose hooks one
 *     listens to (`listensTo`), which the build refuses without it;
 *   - the last theme, since the build needs one.
 *
 * And it warns, without refusing, about an app that uses a connector
 * optionally (`optionalConnectors`), and about removing the theme this
 * checkout's database applies.
 *
 * ── UNDER BOTH LOCKS ────────────────────────────────────────────────────────
 *
 * `repository.register`, renewed every minute, and the checkout lock,
 * `.mixos/lock`, as install and Register hold them (./register.ts). Both are
 * confirmed before each change to the disk, and a removal that finds either
 * gone stops there.
 *
 * 1. The checks again, under the locks.
 * 2. Its backup record (./backup.ts).
 * 3. The registry generator, with `PATH` and `TMPDIR` as its environment,
 *    leaving the extension out (`--without`) while its folder is still in
 *    place. So the registry stops importing it before any of its files go,
 *    and a dev server watching the checkout never compiles an import of a
 *    file that is missing, which it shows as a build error.
 * 4. It failed, stopped, or still lists the extension: its record is cleared
 *    and the registry regenerated with it, so the checkout is as it was.
 *    Accepted: the folder is renamed to `.mixos/backup/<kind dir>/<name>/`,
 *    out of the build, the record says it was accepted, and the backup and
 *    its record are deleted. A pending install of the same name is discarded
 *    with it.
 * 5. Audited: `<kind>.remove`, or `<kind>.remove.rejected` with the reason.
 *
 * The result hands back what to commit (./hand-back.ts): the files the commit
 * deletes, a message built from identifiers, and the commands. An extension
 * installed from a Registry takes its install record, `.registry.json`, with
 * its folder. The server never runs git.
 *
 * A removal that stops midway leaves its backup record, and recovery puts
 * things back (./backup.ts, and recoverCheckout() in ./register.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordAdminAction, type AdminActor } from "../apps/admin-audit";
import { connectorEntryNames } from "../connectors/requirements";
import { sql } from "../db/client";
import { BUILT_DEPLOYMENT_REMOVE_NOTICE, isBuiltDeployment } from "../platform/build";
import { describeCheckoutLockHolder, withCheckoutLock, type CheckoutLock } from "../platform/checkout-lock";
import { withPlatformLock, type PlatformLease } from "../platform/lock";
import {
  backupLocation,
  extensionFolder,
  isExtensionName,
  leftoverBackup,
  leftoverBackupMessage,
  writeBackupRecord,
  type RemovalRecord,
} from "./backup";
import { removalHandBackFor, type RemovalHandBack } from "./hand-back";
import { folderFiles, readInstallRecord, recordMismatch, type InstallRecord } from "./install-record";
import {
  bothLocks,
  checkoutRoot,
  describeLockFailure,
  listedInRegistry,
  runRegistryGenerator,
} from "./install";
import { MIXOS_DIR, isRealDirectory, kindDir, pathExists, pendingLocation, readSidecar } from "./pending";
import { describeRegisterFailure } from "./register";
import { shownText } from "./review";
import { SlugSchema, type ExtensionKind } from "./types";

export type RemoveFailureCode =
  | "unsupported-environment"
  | "not-installed"
  | "interrupted"
  | "depended-on"
  | "last-theme"
  | "generator-failed"
  | "write-failed"
  | "lock-lost"
  | "lock-unconfirmed"
  | "stopped";

export class RemoveError extends Error {
  constructor(
    message: string,
    /** A stable code a caller can branch on without matching prose. */
    readonly code: RemoveFailureCode,
    /** The registry generator's output, when it is what refused. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "RemoveError";
  }
}

/** Any failure here as a code and a message for a person, `locked` among them. */
export function describeRemoveFailure(err: unknown): { code: string; message: string; detail?: string } {
  if (err instanceof RemoveError) return { code: err.code, message: err.message, detail: err.detail };
  return describeRegisterFailure(err);
}

/* -------------------------------------------------------------------------- */
/*  What depends on it                                                         */
/* -------------------------------------------------------------------------- */

/** An app a note names: its folder's name and the name its manifest gives it. */
export interface NamedApp {
  slug: string;
  name: string;
}

/** Something a person should know before removing it: a refusal, or a warning. */
export interface RemovalNote {
  code: "required-by" | "consumed-by" | "listened-to-by" | "last-theme" | "optional-for" | "applied-theme";
  /** For a person: what it is, and what to do about it. */
  message: string;
  /** The apps it names. */
  apps: NamedApp[];
}

/** One app in a build, as far as removal needs it: what its manifest says it depends on. */
export interface AppLinks extends NamedApp {
  connectors: string[];
  optionalConnectors: string[];
  /** The apps whose services it uses. */
  consumes: string[];
  /** The apps whose hooks it listens to. */
  listensTo: string[];
}

/** A theme in a build: its folder's name, and the name its manifest gives it. */
export interface ThemeInBuild {
  slug: string;
  name: string;
}

/**
 * What a build holds, as far as what depends on an extension goes. Read from
 * the manifests in this checkout here, and from the generated registries on a
 * built deployment, which proposes a removal through the GitHub App instead
 * (src/lib/github/propose-change.ts). Either way the same rules judge it.
 */
export interface DependencyFacts {
  /** What holds the facts, for the notes' words: this checkout, or the instance that proposes. */
  here: "checkout" | "instance";
  apps: readonly AppLinks[];
  /** Every theme, by name in order: pages use the first when none is applied (FALLBACK_THEME). */
  themes: readonly ThemeInBuild[];
  /** The theme this database applies: a slug, null for none, undefined if it can't be read. Asked only when it matters. */
  storedTheme(): Promise<string | null | undefined>;
}

/** The manifest each kind is read from, and the field that names it. */
const MANIFEST: Record<ExtensionKind, { file: string; name: string }> = {
  app: { file: "app.json", name: "name" },
  connector: { file: "connector.json", name: "displayName" },
  theme: { file: "theme.json", name: "name" },
};

/** The largest manifest this reads. The schema keeps a real one far smaller. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** A manifest read as JSON and nothing more, never through a link, or null. */
function readManifest(dir: string, kind: ExtensionKind): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = fs.openSync(
      path.join(/* turbopackIgnore: true */ dir, MANIFEST[kind].file),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The name a manifest gives itself, made fit to show, or the folder's name. */
function displayName(manifest: Record<string, unknown> | null, kind: ExtensionKind, slug: string): string {
  const name = manifest?.[MANIFEST[kind].name];
  return typeof name === "string" && name.trim() ? shownText(name) : slug;
}

/**
 * The folders in `apps/`, `connectors/` or `themes/` the registry generator
 * reads as extensions, by name: real folders, not links, and not `_template`
 * or a dot folder (isExtensionFolder() in scripts/generate-project-registry.ts),
 * that hold their manifest.
 */
export function extensionFolders(root: string, kind: ExtensionKind): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(/* turbopackIgnore: true */ root, kindDir(kind)), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .filter((e) => pathExists(path.join(/* turbopackIgnore: true */ root, kindDir(kind), e.name, MANIFEST[kind].file)))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** The `app` of each `{ app, … }` entry in a list, read loosely: an entry that isn't one is skipped. */
const appsNamed = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((v) =>
        v && typeof v === "object" && typeof (v as { app?: unknown }).app === "string"
          ? [(v as { app: string }).app]
          : [],
      )
    : [];

/** Every theme in this checkout, by name, with the name its manifest gives it. */
function checkoutThemes(root: string): ThemeInBuild[] {
  return extensionFolders(root, "theme").map((slug) => ({
    slug,
    name: displayName(readManifest(path.join(/* turbopackIgnore: true */ root, "themes", slug), "theme"), "theme", slug),
  }));
}

/** Every app in this checkout and what it depends on, from its app.json. */
function checkoutApps(root: string): AppLinks[] {
  return extensionFolders(root, "app").map((slug) => {
    const manifest = readManifest(path.join(/* turbopackIgnore: true */ root, "apps", slug), "app");
    return {
      slug,
      name: displayName(manifest, "app", slug),
      connectors: connectorEntryNames(manifest?.connectors),
      optionalConnectors: connectorEntryNames(manifest?.optionalConnectors),
      consumes: appsNamed(manifest?.consumes),
      listensTo: appsNamed(manifest?.listensTo),
    };
  });
}

/** "Notes (apps/notes)", "Notes (apps/notes) and Board (apps/board)". */
function listOf(apps: readonly NamedApp[]): string {
  const named = apps.map((a) => `${a.name} (apps/${a.slug})`);
  return named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

const them = (apps: readonly NamedApp[]) => (apps.length === 1 ? "it" : "them");
const their = (apps: readonly NamedApp[]) => (apps.length === 1 ? "its" : "their");
const s = (apps: readonly NamedApp[]) => (apps.length === 1 ? "s" : "");

/** The theme `platform_settings` applies in this database: a slug, null for none, undefined if it can't be read. */
export async function storedTheme(): Promise<string | null | undefined> {
  try {
    // The key src/lib/themes/active.ts reads and Apply writes.
    const rows = (await sql`
      select value from public.platform_settings where key = 'theme'
    `) as unknown as { value: string }[];
    return rows[0]?.value ?? null;
  } catch {
    return undefined;
  }
}

/** What refuses removing `kind`/`slug` from the checkout at `root`, and what to warn about. */
function dependents(
  root: string,
  kind: ExtensionKind,
  slug: string,
): Promise<{ blockers: RemovalNote[]; warnings: RemovalNote[] }> {
  return dependentsOf({ here: "checkout", apps: checkoutApps(root), themes: checkoutThemes(root), storedTheme }, kind, slug);
}

/**
 * What refuses removing `kind`/`slug` from a build that holds `facts`, and
 * what to warn about: the module comment's rules, from the facts alone.
 */
export async function dependentsOf(
  facts: DependencyFacts,
  kind: ExtensionKind,
  slug: string,
): Promise<{ blockers: RemovalNote[]; warnings: RemovalNote[] }> {
  const blockers: RemovalNote[] = [];
  const warnings: RemovalNote[] = [];
  const here = facts.here === "checkout" ? "this checkout" : "this instance";

  if (kind === "connector") {
    const apps = facts.apps;
    const required = apps.filter((a) => a.connectors.includes(slug));
    // An app that declares it both ways requires it.
    const optional = apps.filter((a) => !a.connectors.includes(slug) && a.optionalConnectors.includes(slug));
    if (required.length > 0) {
      blockers.push({
        code: "required-by",
        apps: required.map(named),
        message:
          `Required by ${listOf(required)}, which can't work without it. Remove ${them(required)} first, ` +
          `or take it out of ${their(required)} \`connectors\`.`,
      });
    }
    if (optional.length > 0) {
      warnings.push({
        code: "optional-for",
        apps: optional.map(named),
        message: `Optional for ${listOf(optional)}: the parts that use it stop working, and the rest keeps working.`,
      });
    }
  }

  if (kind === "app") {
    const others = facts.apps.filter((a) => a.slug !== slug);
    const consumers = others.filter((a) => a.consumes.includes(slug));
    const listeners = others.filter((a) => a.listensTo.includes(slug));
    if (consumers.length > 0) {
      blockers.push({
        code: "consumed-by",
        apps: consumers.map(named),
        message:
          `${listOf(consumers)} use${s(consumers)} its services, and the build fails without it. ` +
          `Remove ${them(consumers)} first, or take it out of ${their(consumers)} \`consumes\`.`,
      });
    }
    if (listeners.length > 0) {
      blockers.push({
        code: "listened-to-by",
        apps: listeners.map(named),
        message:
          `${listOf(listeners)} listen${s(listeners)} to its hooks, and the build fails without it. ` +
          `Remove ${them(listeners)} first, or take it out of ${their(listeners)} \`listensTo\`.`,
      });
    }
  }

  if (kind === "theme") {
    const themes = facts.themes.map((t) => t.slug);
    const left = facts.themes.filter((t) => t.slug !== slug);
    if (left.length === 0) {
      blockers.push({
        code: "last-theme",
        apps: [],
        message: `It is the only theme in ${facts.here === "checkout" ? "this checkout" : "the build"}, and the build needs one. Add another theme first.`,
      });
    } else {
      // What the root layout shows: the applied theme while it is installed,
      // or the first by name (FALLBACK_THEME, written by the generator).
      const stored = await facts.storedTheme();
      const fallbackName = left[0].name;
      if (stored === slug) {
        warnings.push({
          code: "applied-theme",
          apps: [],
          message:
            `It is the applied theme in ${here}'s database, so pages here use ${fallbackName} ` +
            `once it's gone, until an admin applies another. An instance that applies it does the same ` +
            `once the removal is deployed there.`,
        });
      } else if (stored !== undefined && (stored === null || !themes.includes(stored)) && themes[0] === slug) {
        warnings.push({
          code: "applied-theme",
          apps: [],
          message:
            `No theme is applied in ${here}'s database, so pages here use the first theme by name, ` +
            `which is this one. They use ${fallbackName} once it's gone.`,
        });
      }
    }
  }

  return { blockers, warnings };
}

function named(app: AppLinks): NamedApp {
  return { slug: app.slug, name: app.name };
}

/* -------------------------------------------------------------------------- */
/*  The plan                                                                   */
/* -------------------------------------------------------------------------- */

export interface RemovalPlan {
  kind: ExtensionKind;
  /** The folder's name, which is the app's slug, or the connector's or theme's name. */
  slug: string;
  /** The manifest's name, or the slug. */
  name: string;
  /** Repo-relative: `apps/<slug>`. */
  path: string;
  /** Where it was installed from, from its own install record, or null for a local one. */
  installed: Pick<InstallRecord, "source" | "version"> | null;
  /** What stops it being removed now. Removal refuses while there is any. */
  blockers: RemovalNote[];
  /** What a person should know first. */
  warnings: RemovalNote[];
  /** A pending install of the same name, repo-relative, which removal discards. */
  pending: string | null;
}

function assertName(kind: ExtensionKind, slug: string): void {
  if (!isExtensionName(slug)) {
    throw new RemoveError(
      `"${slug.replace(/[^\x20-\x7e]/g, "?")}" is not the name of an extension in ${kindDir(kind)}/.`,
      "not-installed",
    );
  }
}

/**
 * What removing `kind`/`slug` from the checkout at `root` would do, and what
 * stands in its way. Reads the checkout and, for a theme, this checkout's
 * database, and changes nothing: the Remove button's dialog and
 * `npm run remove` show it before they ask, and removal works it out again
 * under its locks. Throws RemoveError when there is nothing to remove, or a
 * stopped operation has to be dealt with first.
 */
export async function planRemoval(kind: ExtensionKind, slug: string, root: string = checkoutRoot()): Promise<RemovalPlan> {
  assertName(kind, slug);
  const live = extensionFolder(root, kind, slug);
  const pending = kind !== "theme" && SlugSchema.safeParse(slug).success ? pendingLocation(root, kind, slug) : null;
  const waiting = pending && (pathExists(pending.folder) || pathExists(pending.sidecar)) ? pending : null;

  const leftover = leftoverBackup(root, kind, slug);
  if (leftover) throw new RemoveError(leftoverBackupMessage(leftover, slug), "interrupted");
  const sidecar = waiting ? readSidecar(waiting.sidecar) : null;
  if (sidecar?.state === "ok" && sidecar.sidecar.register) {
    throw new RemoveError(
      `A registration of ${slug} stopped before it finished. Run \`npm run register -- --recover\` ` +
        "to put things back, then try again.",
      "interrupted",
    );
  }

  const manifest = isRealDirectory(live.dir) ? readManifest(live.dir, kind) : null;
  if (!isRealDirectory(live.dir) || !pathExists(path.join(/* turbopackIgnore: true */ live.dir, MANIFEST[kind].file))) {
    const what = pathExists(live.dir)
      ? isRealDirectory(live.dir)
        ? `${live.rel} has no ${MANIFEST[kind].file}, so the build doesn't read it as ${kind === "app" ? "an app" : `a ${kind}`}.`
        : `${live.rel} is a link, which the build doesn't read as ${kind === "app" ? "an app" : `a ${kind}`}.`
      : `Nothing named ${slug} is in ${kindDir(kind)}/.`;
    throw new RemoveError(
      what +
        (waiting
          ? ` One is waiting in ${waiting.rel}/: discard it with \`npm run register -- ${kind}/${slug} --discard\`.`
          : ""),
      "not-installed",
    );
  }

  // Its own install record, when it has one: where it came from, for the
  // commit message. A record that can't be read or names another extension is
  // left out of the message, and deleted with the folder all the same.
  const read = readInstallRecord(live.dir);
  const installed =
    read.state === "ok" && recordMismatch(read.record, kind, slug) === null
      ? { source: read.record.source, version: read.record.version }
      : null;

  const { blockers, warnings } = await dependents(root, kind, slug);
  return {
    kind,
    slug,
    name: displayName(manifest, kind, slug),
    path: live.rel,
    installed,
    blockers,
    warnings,
    pending: waiting ? waiting.rel : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Removing it                                                                */
/* -------------------------------------------------------------------------- */

/** How a removal was asked for, and by whom. */
export interface RemoveOptions {
  /** Who the audit row names. */
  actor: AdminActor;
  /** How it was asked for, recorded in the audit row. */
  via: "cli" | "button";
  /** Tests: the checkout. This one by default. */
  root?: string;
  /** Tests: a script in the registry generator's place. */
  generator?: string;
  /** Stops the work at its next check. A removal that has moved the folder still puts it back first. */
  signal?: AbortSignal;
  /** Told what a person should know that isn't a failure: a stale lock taken over. */
  notice?: (message: string) => void;
}

export interface RemoveResult extends Omit<RemovalPlan, "blockers" | "pending"> {
  /** The files the folder held, the install record among them, and their bytes. */
  fileCount: number;
  byteCount: number;
  /** The pending install of the same name it discarded, repo-relative, or null. */
  discardedPending: string | null;
  /** What the registry generator printed. */
  output: string;
  /** What to commit, and how. */
  handBack: RemovalHandBack;
  /** What to do next, in a paragraph. */
  nextStep: string;
}

/**
 * Remove `kind`/`slug`'s code from this checkout. Throws RemoveError, or a
 * lock's error, when it refuses; either way it is audited.
 */
export async function removeExtension(kind: ExtensionKind, slug: string, options: RemoveOptions): Promise<RemoveResult> {
  const root = options.root ?? checkoutRoot();
  try {
    const result = await removeUnderLocks(kind, slug, root, options);
    await recordAdminAction(options.actor, {
      action: `${kind}.remove`,
      targetType: kind,
      targetId: slug,
      details: {
        via: options.via,
        path: result.path,
        fileCount: result.fileCount,
        byteCount: result.byteCount,
        ...(result.installed ? { source: result.installed.source, version: result.installed.version } : { local: true }),
        ...noteDetails(result.warnings),
        ...(result.discardedPending ? { discardedPending: result.discardedPending } : {}),
      },
    });
    return result;
  } catch (err) {
    const failure = describeRemoveFailure(err);
    await recordAdminAction(options.actor, {
      action: `${kind}.remove.rejected`,
      targetType: kind,
      targetId: isExtensionName(slug) ? slug : "(not a name)",
      details: {
        via: options.via,
        reason: failure.code,
        // Never the detail, which is the generator's output, nor the words of
        // an error nothing here expected, which can name this machine's paths.
        message: failure.code === "unknown" ? "An unexpected error stopped it." : failure.message,
      },
    });
    throw err;
  }
}

/** The warnings, for the audit row, as the slugs they name: never a manifest's words. */
function noteDetails(notes: readonly RemovalNote[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const note of notes) {
    if (note.code === "optional-for") out.optionalFor = note.apps.map((a) => a.slug);
    if (note.code === "applied-theme") out.appliedTheme = true;
  }
  return out;
}

async function removeUnderLocks(
  kind: ExtensionKind,
  slug: string,
  root: string,
  options: RemoveOptions,
): Promise<RemoveResult> {
  assertName(kind, slug);
  // Before the locks, as for install and Register: a deployment that can't
  // remove anything shouldn't hold up anyone else while it is refused.
  assertRemovable(kind, root, options.generator);

  const purpose = `a removal of ${kind}/${slug}${options.via === "cli" ? " (npm run remove)" : ""}`;
  return withPlatformLock("repository.register", (lease) =>
    withCheckoutLock(root, purpose, (lock) => {
      tellTakeover(lock, options);
      return runRemove(kind, slug, root, lock.token, bothLocks(lease, lock), options);
    }),
  );
}

/**
 * The environment removal needs: a checkout, not a built deployment; a
 * writable folder to remove from and `.mixos/` to keep the backup in; and the
 * generator, which it runs.
 */
function assertRemovable(kind: ExtensionKind, root: string, generator?: string): void {
  if (isBuiltDeployment()) {
    throw new RemoveError(BUILT_DEPLOYMENT_REMOVE_NOTICE, "unsupported-environment");
  }
  for (const dir of [kindDir(kind), MIXOS_DIR]) {
    const full = path.join(/* turbopackIgnore: true */ root, dir);
    try {
      fs.accessSync(pathExists(full) ? full : root, fs.constants.W_OK);
    } catch {
      throw new RemoveError(
        `${dir}/ is not writable in this checkout, so nothing can be removed from it.`,
        "unsupported-environment",
      );
    }
  }
  const script = path.join(
    /* turbopackIgnore: true */ generator ?? path.join(/* turbopackIgnore: true */ root, "scripts", "generate-project-registry.ts"),
  );
  if (!fs.existsSync(script)) {
    throw new RemoveError(
      "The registry generator isn't in this checkout, so nothing can be removed here.",
      "unsupported-environment",
    );
  }
}

/** Say so when taking the checkout lock meant taking over one whose holder had stopped. */
function tellTakeover(lock: CheckoutLock, options: RemoveOptions): void {
  if (!lock.tookOver) return;
  (options.notice ?? console.warn)(
    `Took over the checkout lock from ${describeCheckoutLockHolder(lock.tookOver)}, which had stopped.`,
  );
}

/**
 * The checks every disk change here starts with: not stopped, and both locks
 * still held. `finishing` skips the first, for the steps that put the checkout
 * back as it was or finish what the generator accepted, which a Ctrl-C should
 * not leave half done.
 */
function fencer(lease: PlatformLease, signal?: AbortSignal) {
  return async (left: string, detail?: string, { finishing = false } = {}): Promise<void> => {
    if (signal?.aborted && !finishing) {
      throw new RemoveError(`Stopped before it finished. ${left}`, "stopped", detail);
    }
    try {
      await lease.assertHeld();
    } catch (err) {
      const { code, message } = describeLockFailure(err, "This removal");
      throw new RemoveError(`${message} ${left}`, code, detail);
    }
  };
}

async function runRemove(
  kind: ExtensionKind,
  slug: string,
  root: string,
  lockToken: string,
  lease: PlatformLease,
  options: RemoveOptions,
): Promise<RemoveResult> {
  const fence = fencer(lease, options.signal);
  const generator = { lockToken, root: options.root, generator: options.generator };

  // 1. The checks again, now that nothing else can change the checkout.
  const plan = await planRemoval(kind, slug, root);
  if (plan.blockers.length > 0) {
    throw new RemoveError(
      `${plan.name} can't be removed. ${plan.blockers.map((b) => b.message).join(" ")} Nothing was changed.`,
      plan.blockers.some((b) => b.code === "last-theme") ? "last-theme" : "depended-on",
    );
  }
  const live = extensionFolder(root, kind, slug);
  const backup = backupLocation(root, kind, slug);
  const files = folderFiles(live.dir);

  // 2. Its record, before anything changes.
  await fence(`Nothing was moved: ${live.rel} is where it was.`);
  const record: RemovalRecord = {
    operation: "remove",
    kind,
    slug,
    token: lockToken,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  writeBackupRecord(backup.record, record);

  // 3. The registry without it, while its folder is still in place. Moving
  // the folder first left the registry importing its files, gone, until the
  // run finished, and a dev server compiled that in between as a build error.
  // A run that finishes and still lists it has gone wrong somewhere, and
  // counts as a failure.
  const run = await runRegistryGenerator({ ...generator, without: { kind, slug }, signal: options.signal });
  const accepted = run.code === 0 && !(await listedInRegistry(kind, slug, options.root));

  // Kept: its record cleared, then the registry again, with it, since the run
  // that left it out may have rewritten it. That run has its own time limit
  // and isn't stopped by a Ctrl-C: it is what leaves the checkout as it was.
  const keep = async (): Promise<boolean> => {
    fs.rmSync(backup.record, { force: true });
    return (await runRegistryGenerator(generator)).code === 0;
  };

  if (!accepted) {
    // 4. Its folder never moved.
    await fence(
      `${live.rel} is where it was, but the registry may not list it. Run \`npm run remove -- --recover\` to ` +
        "regenerate it.",
      run.output,
      { finishing: true },
    );
    const restored = await keep();
    throw notRemoved(plan, run, restored, options.signal?.aborted === true);
  }

  // 4. Accepted: now the folder out of the build, which nothing imports any
  // more. The record says so only once it has moved, so recovery from a stop
  // in between puts it back, where it was or from `.mixos/backup/`.
  await fence(
    `The registry no longer has ${slug}, but ${live.rel} is still in place. Run ` +
      "`npm run remove -- --recover` to put it back in the registry, then remove it again.",
    undefined,
    { finishing: true },
  );
  try {
    fs.mkdirSync(path.dirname(backup.folder), { recursive: true });
    fs.renameSync(live.dir, backup.folder);
  } catch (err) {
    const restored = await keep();
    throw new RemoveError(
      `Could not move ${live.rel} out of the build, so it was kept: ${err instanceof Error ? err.message : String(err)}` +
        (restored
          ? ""
          : " Regenerating the registry afterwards failed, so src/generated/ may not list it: run `npm run registry`."),
      "write-failed",
    );
  }
  // From here the backup is only being deleted, and recovery finishes that
  // rather than putting it back.
  writeBackupRecord(backup.record, { ...record, accepted: true });
  fs.rmSync(backup.folder, { recursive: true, force: true });
  fs.rmSync(backup.record, { force: true });

  // A pending install of the same name goes with it: what it would have
  // replaced, or been registered beside, is gone.
  let discardedPending: string | null = null;
  if (plan.pending && kind !== "theme") {
    await fence(
      `${live.rel} is removed, but ${plan.pending}/ is still waiting: discard it with ` +
        `\`npm run register -- ${kind}/${slug} --discard\`.`,
      undefined,
      { finishing: true },
    );
    const where = pendingLocation(root, kind, slug);
    fs.rmSync(where.folder, { recursive: true, force: true });
    fs.rmSync(where.sidecar, { force: true });
    discardedPending = where.rel;
  }

  return {
    kind,
    slug,
    name: plan.name,
    path: live.rel,
    installed: plan.installed,
    warnings: plan.warnings,
    fileCount: files.length,
    byteCount: files.reduce((n, f) => n + f.bytes, 0),
    discardedPending,
    output: run.output,
    handBack: removalHandBackFor({ kind, slug, installed: plan.installed }, live.rel, files),
    nextStep: nextStep(kind, live.rel),
  };
}

/** Why a removal the generator didn't accept was put back. */
function notRemoved(
  plan: RemovalPlan,
  run: { code: number | null; output: string },
  restored: boolean,
  stopped: boolean,
): RemoveError {
  const after = restored
    ? ""
    : " Regenerating the registry afterwards failed too, so src/generated/ may not list it: run `npm run registry`.";
  if (stopped) {
    return new RemoveError(`Stopped before it finished. ${plan.path} was kept.${after}`, "stopped", run.output);
  }
  if (run.code === null) {
    return new RemoveError(
      `The registry generator didn't finish without ${plan.path}, so it was kept.${after}`,
      "generator-failed",
      run.output,
    );
  }
  if (run.code !== 0) {
    return new RemoveError(
      `The registry generator failed without ${plan.path}, so it was kept. The output below says why.${after}`,
      "generator-failed",
      run.output,
    );
  }
  return new RemoveError(
    `The registry still lists ${plan.slug} after the generator ran without it, so ${plan.path} was kept.${after}`,
    "generator-failed",
    run.output,
  );
}

function nextStep(kind: ExtensionKind, rel: string): string {
  const removed = `Removed ${rel} from this checkout, and the registry no longer has it.`;
  switch (kind) {
    case "app":
      return (
        `${removed} Its data stays in this checkout's database, and Admin > Apps lists it under ` +
        "Not in this build. Commit the deletion and deploy: each instance keeps the app's data until " +
        "an admin deletes it there."
      );
    case "connector":
      return (
        `${removed} Its credentials, and its users' connections, stay in this checkout's database. ` +
        "Commit the deletion and deploy: each instance keeps the connector's credentials until an " +
        "admin deletes them there."
      );
    case "theme":
      return `${removed} Commit the deletion and deploy.`;
  }
}
