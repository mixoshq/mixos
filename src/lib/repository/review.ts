/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What an admin reads before registering a pending install: what will run,
 * what install's check left to registration, what the package's manifest
 * declares, and whether this checkout's version meets the release's floor.
 *
 * All of it comes from the pending install itself: its install record,
 * `.registry.json`, which says what install verified and where it came from;
 * its sidecar, which has the check's verdict and who installed it; and its
 * folder, read as text. The link to the source is built from the record, so it
 * is the repository and commit install downloaded and verified. Nothing here
 * imports, evaluates or executes a file the package ships. The publisher's
 * claims come from the catalogue, which the review action asks separately
 * (listingFacts() in ./pending-admin.ts).
 *
 * Every path below is a runtime path in a checkout, built from arguments, so
 * each join is marked for Turbopack's tracer to leave alone (see ./pending.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { floorVerdict } from "../platform/version";
import type { FloorVerdict } from "../platform/version-floor";
import { contentHashesMatch } from "./content-hash";
import {
  FolderReadError,
  INSTALL_RECORD_FILE,
  folderFiles,
  folderFilesHash,
  readInstallRecord,
  recordSourceUrl,
  type InstallRecord,
} from "./install-record";
import {
  MIXOS_DIR,
  isRealDirectory,
  kindDir,
  listPendingInstalls,
  pendingLocation,
  pendingUpdateProblem,
  readSidecar,
  recordProblem,
  type PendingKind,
  type PendingSidecar,
} from "./pending";

/** One group of files that will run, as the review lists them. */
export interface RunGroup {
  /** What the group is: `hooks.ts`, `api/`, `migrations/*.sql`. */
  label: string;
  /** When it runs, for a person. */
  note: string;
  /** Paths inside the extension's folder, sorted, at most MAX_LISTED. */
  files: string[];
  /** How many more there are than `files` lists. */
  more: number;
}

/** One thing the package's own manifest declares. */
export interface Declaration {
  label: string;
  /** Empty when the manifest declares none. */
  values: string[];
}

export interface PendingReview {
  kind: PendingKind;
  slug: string;
  /** The manifest's name, or the slug when it has none that reads. */
  name: string;
  /** Repo-relative: `.mixos/pending/apps/<slug>`. */
  folder: string;
  /** Repo-relative: where Register puts it, `apps/<slug>`. */
  target: string;
  /** What install verified, from the install record, and who installed it, from the sidecar. */
  release: Pick<InstallRecord, "source" | "version" | "gitTag" | "commitSha" | "contentHash" | "filesHash"> &
    Pick<PendingSidecar, "installedAt" | "installedBy" | "yankedAccepted"> & {
      /** The package's files and their bytes, the install record left out. */
      fileCount: number;
      byteCount: number;
    };
  /** The source on GitHub at the commit install verified, from the install record. */
  sourceUrl: string | null;
  /** The files that will run, by group. */
  runs: RunGroup[];
  /** What install's check couldn't read as text and left to registration. */
  deferred: string[];
  /** What the package's manifest declares. Null when it can't be read. */
  declared: Declaration[] | null;
  /** The release's floor against this checkout's version. `met` is false when Register would refuse it. */
  requiresMixOS: FloorVerdict;
  /**
   * What stands in the way of registering it now, or null. Register checks all
   * of it again under its locks; this says so before anyone asks.
   */
  problem: string | null;
}

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

/** Per group, so a package of thousands of routes still renders as a review. */
const MAX_LISTED = 40;

/** The largest manifest this reads. The schema keeps a real one far smaller. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** A declared value longer than this is cut, so one field can't swamp the review. */
const MAX_VALUE_CHARS = 120;

/** A deferred check's line, or a claim's reason, is longer prose. */
export const MAX_LINE_CHARS = 400;

/** Values listed per declaration. */
const MAX_VALUES = 50;

/** Code a package can ship, by extension. */
const CODE = /\.(?:[cm]?[jt]sx?)$/;

/* -------------------------------------------------------------------------- */
/*  Reading the folder                                                          */
/* -------------------------------------------------------------------------- */

/** A small file's text, never through a link, or null. */
function readText(file: string, limit: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return null;
    return fs.readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The manifest in an extension's folder, pending or in place, parsed as JSON
 * and nothing more, or null.
 */
export function readManifest(folder: string, kind: PendingKind): Record<string, unknown> | null {
  const file = path.join(/* turbopackIgnore: true */ folder, kind === "app" ? "app.json" : "connector.json");
  const text = readText(file, MAX_MANIFEST_BYTES);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Text from the package, made fit to show: one line, no control characters, capped. */
export function shownText(value: string, max: number = MAX_VALUE_CHARS): string {
  const flat = value.replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The name a pending install's manifest gives itself, or its slug. */
export function pendingDisplayName(root: string, kind: PendingKind, slug: string): string {
  const manifest = readManifest(pendingLocation(root, kind, slug).folder, kind);
  const name = manifest?.[kind === "app" ? "name" : "displayName"];
  return typeof name === "string" && name.trim() ? shownText(name) : slug;
}

/** How many `.sql` files an app folder's `migrations/` holds. */
export function migrationCount(appDir: string): number {
  try {
    return fs
      .readdirSync(path.join(/* turbopackIgnore: true */ appDir, "migrations"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".sql")).length;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  What will run                                                               */
/* -------------------------------------------------------------------------- */

function group(label: string, note: string, files: string[]): RunGroup {
  return { label, note, files: files.slice(0, MAX_LISTED), more: Math.max(0, files.length - MAX_LISTED) };
}

/**
 * What runs, and when. For an app: the files that run on their own, at
 * registration or by the release step, then any other code in the package,
 * which runs when it is used. For a connector, its code.
 */
export function runGroups(kind: PendingKind, files: readonly string[]): RunGroup[] {
  if (kind === "connector") {
    return [
      group(
        "Code",
        "The server loads it whenever the connector is used: by an app, a webhook or Test Connection.",
        files.filter((f) => CODE.test(f)),
      ),
    ];
  }
  const hooks = files.filter((f) => f === "hooks.ts");
  const api = files.filter((f) => f.startsWith("api/"));
  const widgets = files.filter((f) => f === "widgets.ts");
  const jobs = files.filter((f) => f.startsWith("jobs/"));
  const migrations = files.filter((f) => /^migrations\/[^/]+\.sql$/.test(f));
  const listed = new Set([...hooks, ...api, ...widgets, ...jobs]);
  const other = files.filter((f) => CODE.test(f) && !listed.has(f));
  return [
    group("hooks.ts", "The server loads it to run the app's hooks, brand hooks on every page included.", hooks),
    group("api/", "Route handlers. Registering loads each one, and the server runs them on request.", api),
    group("widgets.ts", "Loaded when it is registered, to build the widgets' settings.", widgets),
    group("jobs/", "Scheduled jobs, which the scheduler runs.", jobs),
    group(
      "migrations/*.sql",
      "Applied to the database by the release step, and by `npm run migrate:apps` in a checkout.",
      migrations,
    ),
    group("Other code", "Pages, widgets, MCP tools and the rest, which run when they are used.", other),
  ];
}

/* -------------------------------------------------------------------------- */
/*  What the manifest declares                                                  */
/* -------------------------------------------------------------------------- */

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v))
    : [];

const field = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? (record[key] as string) : null;

/** Every value, made fit to show, once each. */
function declaration(label: string, values: (string | null)[]): Declaration {
  const kept = values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => shownText(v));
  return { label, values: [...new Set(kept)] };
}

/** At most MAX_VALUES of them, and how many more, for a review to list. */
function capped({ label, values }: Declaration): Declaration {
  return {
    label,
    values: values.length > MAX_VALUES ? [...values.slice(0, MAX_VALUES), `and ${values.length - MAX_VALUES} more`] : values,
  };
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * What a manifest declares, by what the review compares with the publisher's
 * claims: egress, env, database, connectors, services, hooks and MCP tools for
 * an app; the hosts it reaches, its credentials, per-user accounts and webhooks
 * for a connector. Read field by field from JSON install's check already
 * validated, and shown as text, at most MAX_VALUES per declaration.
 */
export function declaredBy(kind: PendingKind, manifest: Record<string, unknown>): Declaration[] {
  return declaredValues(kind, manifest).map(capped);
}

/**
 * The same, with every value, for comparing two manifests: an update's dialog
 * says what a release adds and drops (./update.ts). Read loosely, as the
 * review reads it, so it also reads a manifest no check has seen yet.
 */
export function declaredValues(kind: PendingKind, manifest: Record<string, unknown>): Declaration[] {
  if (kind === "connector") {
    const auth = (manifest.auth ?? {}) as Record<string, unknown>;
    const http = (manifest.http ?? {}) as Record<string, unknown>;
    return [
      declaration("Hosts it reaches", [hostOf(http.baseUrl), hostOf(auth.tokenUrl), hostOf(auth.authorizeUrl)]),
      declaration(
        "Credentials an admin enters",
        records(manifest.credentialFields).map((f) => field(f, "key")),
      ),
      declaration("Each person's own account", [manifest.userScoped === true ? "Yes: each person signs in with their own" : null]),
      declaration("Webhooks", [manifest.webhook ? "Receives signed webhooks" : null]),
    ];
  }

  const branding = (manifest.branding ?? {}) as Record<string, unknown>;
  return [
    declaration("Egress", strings(manifest.egress)),
    declaration(
      "Env",
      records(manifest.env).map((e) => {
        const key = field(e, "key");
        return key && e.type === "password" ? `${key} (secret)` : key;
      }),
    ),
    declaration("Database", [manifest.database === true ? "Its own schema and database role" : null]),
    declaration("Connectors", [
      ...strings(manifest.connectors),
      ...strings(manifest.optionalConnectors).map((c) => `${c} (optional)`),
    ]),
    declaration("Services", [
      ...records(manifest.provides).map((s) => (field(s, "name") ? `provides ${field(s, "name")}` : null)),
      ...records(manifest.consumes).map((s) =>
        field(s, "app") && field(s, "service") ? `uses ${field(s, "app")}/${field(s, "service")}` : null,
      ),
    ]),
    declaration("Hooks", [
      ...records(manifest.emits).map((h) => (field(h, "name") ? `emits ${field(h, "name")}` : null)),
      ...records(manifest.listensTo).map((h) =>
        field(h, "app") && field(h, "hook") ? `listens to ${field(h, "app")}.${field(h, "hook")}` : null,
      ),
      ...strings(branding.hooks).map((h) => `brand hook ${h}`),
    ]),
    declaration("MCP tools", records(manifest.mcp).map((t) => field(t, "name"))),
  ];
}

/* -------------------------------------------------------------------------- */
/*  The review                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The review of one pending install in the checkout at `root`. Reads only, and
 * takes no lock: Register checks everything again under both of its locks.
 *
 * Throws ReviewError when there is nothing to review: no pending install of
 * that name, or one without a readable sidecar or install record of its own.
 */
export function reviewPendingInstall(root: string, kind: PendingKind, slug: string): PendingReview {
  const where = pendingLocation(root, kind, slug);
  const read = readSidecar(where.sidecar);
  const recordRead = isRealDirectory(where.folder) ? readInstallRecord(where.folder) : null;
  if (
    read.state !== "ok" ||
    !recordRead ||
    recordRead.state !== "ok" ||
    recordProblem(where, kind, slug, recordRead) !== null
  ) {
    const listed = listPendingInstalls(root).find((p) => p.kind === kind && p.slug === slug);
    throw new ReviewError(
      listed?.problem ?? `Nothing named ${slug} is waiting in ${MIXOS_DIR}/pending/${kindDir(kind)}/.`,
    );
  }
  const sidecar = read.sidecar;
  const record = recordRead.record;
  if (sidecar.kind !== kind || sidecar.slug !== slug) {
    throw new ReviewError(`${where.rel}.json records ${sidecar.kind}/${sidecar.slug}, not ${kind}/${slug}. Discard it.`);
  }

  // The package's files: everything in the folder but the record install added.
  const listed = folderFiles(where.folder).filter((f) => f.path !== INSTALL_RECORD_FILE);
  const files = listed.map((f) => f.path);
  const manifest = readManifest(where.folder, kind);

  // What Register will find: the files as install verified them, or not.
  let problem: string | null = null;
  if (sidecar.register) {
    problem = "A registration of it stopped before it finished. Run `npm run register -- --recover` in this checkout.";
  } else if (sidecar.replaces) {
    problem = pendingUpdateProblem(kind, slug, sidecar.replaces, record.version);
  } else {
    try {
      if (!contentHashesMatch(folderFilesHash(where.folder), record.filesHash)) {
        problem =
          "Its files have changed since it was installed, so Register would refuse it. Discard it and install it again.";
      }
    } catch (err) {
      if (!(err instanceof FolderReadError)) throw err;
      problem = `${err.message} Register would refuse it. Discard it and install it again.`;
    }
  }

  const floor = floorVerdict(record.requiresMixOS);
  if (!problem && !floor.met) problem = floor.reason ?? "This checkout's MixOS is older than the release requires.";

  const name = manifest?.[kind === "app" ? "name" : "displayName"];
  return {
    kind,
    slug,
    name: typeof name === "string" && name.trim() ? shownText(name) : slug,
    folder: where.rel,
    target: `${kindDir(kind)}/${slug}`,
    release: {
      source: record.source,
      version: record.version,
      gitTag: record.gitTag,
      commitSha: record.commitSha,
      contentHash: record.contentHash,
      filesHash: record.filesHash,
      installedAt: sidecar.installedAt,
      installedBy: sidecar.installedBy,
      fileCount: listed.length,
      byteCount: listed.reduce((n, f) => n + f.bytes, 0),
      yankedAccepted: sidecar.yankedAccepted,
    },
    sourceUrl: recordSourceUrl(record),
    runs: runGroups(kind, files),
    deferred: sidecar.check.deferred.map((d) => shownText(d, MAX_LINE_CHARS)),
    declared: manifest ? declaredBy(kind, manifest) : null,
    requiresMixOS: floor,
    problem,
  };
}
