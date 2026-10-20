/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What an app needs from a connector, and whether a connector's version gives
 * it. See docs/plans/20261020_0728-connector-contracts.md.
 *
 * Pure, and with no import a script can't load: the registry generator, the
 * pre-commit contract check and the install review read manifests through it,
 * as the app context does.
 *
 * ── AN APP'S ENTRY ──────────────────────────────────────────────────────────
 *
 * Each entry in an app's `connectors` and `optionalConnectors` names a
 * connector and the version the app was built against:
 *
 *   "connectors": [
 *     { "name": "monday", "version": "2.1.0" },
 *     { "name": "google-sheets", "version": "1.2.0", "access": "write" }
 *   ]
 *
 * `access` is "read" unless the entry says "write". An app needs "write" to
 * call a method its connector declares `mutates`, and the platform holds it to
 * that (src/lib/apps/context.ts). The version is required: an app that named
 * none could be handed any release, including one that removed what it calls.
 *
 * ── VERSIONS ────────────────────────────────────────────────────────────────
 *
 * A connector's `version` is `X.Y.Z`. Within a major version a connector only
 * adds: methods, optional parameters, fields in what it returns. So an app
 * built against 1.2.0 works with 1.2.0 and any later 1.x release, and not with
 * 2.0.0. That is a floor within a major version, not a range grammar, for the
 * reason src/lib/platform/version-floor.ts gives for `requiresMixOS`. Major
 * version 0 is a major version like any other.
 */

/** What an app's entry asks of a connector. */
export type ConnectorAccessNeed = "read" | "write";

/** One connector an app declares, in either list. */
export interface ConnectorRequirement {
  name: string;
  /** Declared in `optionalConnectors`: a part of the app works without it. */
  optional: boolean;
  /** "write" to call a method the connector declares `mutates`. */
  access: ConnectorAccessNeed;
  /** The connector version the app was built against. */
  version: string;
}

/** A connector's `version`, or an app's: three numbers and nothing else. */
export const CONNECTOR_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ConnectorVersion {
  major: number;
  minor: number;
  patch: number;
}

/** `X.Y.Z` as numbers, or null for anything else. */
export function parseConnectorVersion(raw: string): ConnectorVersion | null {
  const m = CONNECTOR_VERSION_PATTERN.exec(raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1, 0 or 1. */
export function compareConnectorVersions(a: ConnectorVersion, b: ConnectorVersion): -1 | 0 | 1 {
  for (const part of ["major", "minor", "patch"] as const) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  return 0;
}

/**
 * Does a connector at version `actual` give an app built against `required`?
 * The same major version, and at least `required`. False when either isn't a
 * version.
 */
export function satisfiesConnectorVersion(required: string, actual: string): boolean {
  const want = parseConnectorVersion(required);
  const have = parseConnectorVersion(actual);
  if (!want || !have) return false;
  return have.major === want.major && compareConnectorVersions(have, want) >= 0;
}

/** "1.2.0 or a later 1.x release", for a message about `required`. */
export function describeConnectorVersion(required: string): string {
  const want = parseConnectorVersion(required);
  return want ? `${required} or a later ${want.major}.x release` : required;
}

/* -------------------------------------------------------------------------- */
/*  Reading entries                                                            */
/* -------------------------------------------------------------------------- */

/** An entry as app.json writes one. */
export interface ConnectorEntry {
  name: string;
  version: string;
  access?: ConnectorAccessNeed;
}

/** The name an entry gives, or null when it isn't an entry. */
export function connectorEntryName(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const name = (entry as { name?: unknown }).name;
  return typeof name === "string" && name ? name : null;
}

/**
 * The connector names in a list as app.json holds it. Anything that isn't an
 * entry is skipped: this also reads manifests nothing has validated yet, such
 * as a package waiting for review, where the schema is what rejects them.
 */
export function connectorEntryNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(connectorEntryName).filter((n): n is string => n !== null);
}

/** One entry as a requirement, or null when it isn't a whole entry. */
function requirementOf(entry: unknown, optional: boolean): ConnectorRequirement | null {
  const name = connectorEntryName(entry);
  const { access, version } = (entry ?? {}) as { access?: unknown; version?: unknown };
  if (!name || typeof version !== "string" || !version) return null;
  return { name, optional, access: access === "write" ? "write" : "read", version };
}

/**
 * Both lists as requirements, required ones first, each in its declared order.
 * Tolerant like `connectorEntryNames`.
 */
export function connectorRequirements(
  connectors: unknown,
  optionalConnectors: unknown,
): ConnectorRequirement[] {
  const read = (value: unknown, optional: boolean) =>
    Array.isArray(value)
      ? value
          .map((entry) => requirementOf(entry, optional))
          .filter((r): r is ConnectorRequirement => r !== null)
      : [];
  return [...read(connectors, false), ...read(optionalConnectors, true)];
}

/** "google-sheets 1.2.0 or later, changes data", for a list a person reads. */
export function describeRequirement(r: ConnectorRequirement): string {
  const parts = [`${r.name} ${r.version} or later`];
  if (r.access === "write") parts.push("changes data");
  if (r.optional) parts.push("optional");
  return parts.join(", ");
}

/* -------------------------------------------------------------------------- */
/*  The contract between two versions of a connector                           */
/* -------------------------------------------------------------------------- */

/** A declared method, as `connector.json`'s `telemetry` lists it. */
export interface DeclaredMethod {
  method: string;
  mutates?: boolean;
}

/** What a connector's own declarations say about it, for a comparison. */
export interface ConnectorSurface {
  version: string | undefined;
  telemetry: readonly DeclaredMethod[] | undefined;
}

/**
 * A `connector.json`'s text as the surface the contract compares, or null when
 * there is none to read: no file, or not JSON. Fields of the wrong shape read
 * as absent; the schema is what reports them.
 */
export function connectorSurfaceOf(text: string | null | undefined): ConnectorSurface | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { version, telemetry } = raw as { version?: unknown; telemetry?: unknown };
  return {
    version: typeof version === "string" ? version : undefined,
    telemetry: Array.isArray(telemetry)
      ? telemetry
          .filter((t): t is { method: string; mutates?: unknown } => typeof t?.method === "string")
          .map((t) => ({ method: t.method, mutates: t.mutates === true }))
      : undefined,
  };
}

/** How the declared methods changed from one version to the next. */
export interface MethodChanges {
  added: string[];
  removed: string[];
  /** Methods that were reads and are now declared `mutates`. */
  madeWrites: string[];
}

export function compareDeclaredMethods(
  before: readonly DeclaredMethod[] | undefined,
  after: readonly DeclaredMethod[] | undefined,
): MethodChanges {
  const was = new Map((before ?? []).map((m) => [m.method, m.mutates === true]));
  const now = new Map((after ?? []).map((m) => [m.method, m.mutates === true]));
  return {
    added: [...now.keys()].filter((m) => !was.has(m)).sort(),
    removed: [...was.keys()].filter((m) => !now.has(m)).sort(),
    madeWrites: [...now].filter(([m, writes]) => writes && was.get(m) === false).map(([m]) => m).sort(),
  };
}

/** "`a`", "`a` and `b`", "`a`, `b` and `c`". */
function methodList(methods: readonly string[]): string {
  const named = methods.map((m) => `\`${m}\``);
  return named.length <= 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/**
 * What the contract refuses in moving a connector from `before` to `after`, as
 * sentences, or none. Within a major version a connector only adds, so:
 *
 *   - its version never goes backwards;
 *   - a removed method, or a read now declared `mutates`, needs a higher major
 *     version: an app built against the old one may call it, or may hold only
 *     read access;
 *   - with `release`, for a new release of a published connector: the version
 *     must be higher than the last release's, and an added method needs at
 *     least a higher minor version, so an app that needs it can say so.
 *
 * Signatures are not compared: the manifest doesn't carry them. Changing what a
 * method takes or returns is a breaking change all the same, and the rules in
 * connectors/AGENTS.md say so.
 */
export function contractProblems(
  before: ConnectorSurface,
  after: ConnectorSurface,
  { release = false }: { release?: boolean } = {},
): string[] {
  const was = before.version ? parseConnectorVersion(before.version) : null;
  const now = after.version ? parseConnectorVersion(after.version) : null;
  // Nothing to hold a version to: the schema reports a missing or malformed one.
  if (!was || !now) return [];

  const order = compareConnectorVersions(now, was);
  if (order < 0) {
    return [`its version went backwards, from ${before.version} to ${after.version}.`];
  }

  const problems: string[] = [];
  const changes = compareDeclaredMethods(before.telemetry, after.telemetry);
  const breaking: string[] = [];
  if (changes.removed.length > 0) breaking.push(`removes ${methodList(changes.removed)}`);
  if (changes.madeWrites.length > 0) {
    breaking.push(`declares ${methodList(changes.madeWrites)} \`mutates\`, which ${changes.madeWrites.length === 1 ? "was a read" : "were reads"}`);
  }
  if (breaking.length > 0 && now.major <= was.major) {
    problems.push(
      `it ${breaking.join(" and ")}, which an app built against ${before.version} may rely on, ` +
        `so it needs a new major version: ${was.major + 1}.0.0, not ${after.version}.`,
    );
  }

  if (release) {
    if (order === 0) {
      problems.push(`its version is still ${after.version}: a new release needs a higher one.`);
    } else if (changes.added.length > 0 && now.major === was.major && now.minor === was.minor) {
      problems.push(
        `it adds ${methodList(changes.added)}, so it needs at least a new minor version, ` +
          `${was.major}.${was.minor + 1}.0, for an app that needs ${changes.added.length === 1 ? "it" : "them"} to name.`,
      );
    }
  }
  return problems;
}
