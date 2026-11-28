/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConnectorRequirement } from "./requirements";
import type { ConnectorManifest } from "./types";

/**
 * What each app can reach on one connector, for the Reach section of Admin →
 * Connectors: which apps declare it, whether each one runs, and which of the
 * connector's methods MixOS lets each one call.
 *
 * It applies the rules an app's connectors are handed with
 * (`appReachRules` and `narrowConnector`, src/lib/apps/connector-reach.ts):
 *
 *   - every declared read, to every app that declares the connector, required
 *     or optional;
 *   - every declared write, only to an app whose entry asks for
 *     `"access": "write"`, and only once an admin has allowed the connector to
 *     change data;
 *   - nothing else.
 *
 * And the app gate's (src/lib/apps/app-gate.ts): an inactive app runs none of
 * its code, so it calls nothing until it is activated. Its methods are still
 * listed, since they are what activating it hands it.
 *
 * Read from the manifests, the activity switch and Allow changes, so it is what
 * MixOS allows, not what the provider does: the credential's own scopes bound
 * that, on the Methods and Scopes tabs. MCP tools and search handlers are
 * read-only whatever this says (src/lib/apps/read-only.ts).
 *
 * Pure and safe on the client. The callers pass the registries in.
 */

/** How far back the Reach section looks for calls (./observed.ts). */
export const OBSERVED_DAYS = 30;

/** One app's calls to one method, within `OBSERVED_DAYS`. */
export interface ObservedCall {
  /** The app that made them; null when none was recorded. */
  appSlug: string | null;
  /** Its name in this build; null for an app the build doesn't carry. */
  appName: string | null;
  method: string;
  calls: number;
  /** How many of them failed. */
  errors: number;
  /** Calls the platform refused before the connector ran them, not counted in `calls`. */
  refused: number;
}

/** Per connector name, its calls, the most made first. Every name asked for has a list. */
export type ObservedCalls = Record<string, ObservedCall[]>;

/**
 * One app's own credentials for a tenant connector (./app-config.ts), as the
 * admin page shows them: never the values, only how far they are set up.
 */
export interface OwnCredentialStatus {
  appSlug: string;
  /**
   * The rule the runtime's `configured` uses (./status.ts), applied to the
   * app's own set; "unreadable" when the row can't be decrypted, and the app
   * then has the connector unconfigured.
   */
  state: "ready" | "needs-authorization" | "unconfigured" | "unreadable";
  /** When they were last saved, and by whom. */
  configuredAt: number | null;
  configuredBy: string | null;
  /** When Verify connection last succeeded with them. */
  verifiedAt: number | null;
  verifiedDetail: string | null;
}

/**
 * An admin's narrowing of one app's reach on one connector (./app-access.ts):
 * writes taken away, or a list of the only methods it may call. Only narrows.
 */
export interface AppNarrowing {
  writes: "inherit" | "deny";
  /** The only methods it may call, or null for every one it could reach. */
  methods: string[] | null;
}

/** What an app may do with the connector's methods that change data. */
export type AppWriteReach =
  /** The connector declares no method that changes data. */
  | "none"
  /** The app's entry doesn't ask for `"access": "write"`. */
  | "not-asked"
  /** It asks, and an admin hasn't allowed this connector to change data. */
  | "read-only"
  /** It asks, and an admin has allowed it: every write is the app's to call. */
  | "allowed"
  /** It asks and changes are allowed, and an admin took this app's writes away here. */
  | "denied";

export interface AppReach {
  slug: string;
  name: string;
  /**
   * Whether an admin has the app switched on. Null when that couldn't be read,
   * and counted as running: the section never shows less reach than there is.
   */
  active: boolean | null;
  /** Declared in `optionalConnectors` rather than `connectors`. */
  optional: boolean;
  /** The connector's declared reads: the app may call each one. */
  reads: string[];
  /** The declared writes the app may call: all of them when `write` is "allowed", or none. */
  writes: string[];
  write: AppWriteReach;
  /** It runs, the connector is enabled, and it may change data with it. */
  canWriteNow: boolean;
  /** An admin narrowed what it may call here (./app-access.ts), or null. */
  narrowing: AppNarrowing | null;
}

export interface ConnectorReach {
  /** Every app that declares the connector: the running ones first, then by name. */
  apps: AppReach[];
  /** Whether each app's switch was read. When it wasn't, every app counts as running. */
  activityKnown: boolean;
  /** Apps whose code runs: active ones, and any whose switch couldn't be read. */
  runningCount: number;
  /** Apps that can change data through it now. */
  canWriteCount: number;
  /** Whether the connector declares any method that changes data. */
  declaresWrites: boolean;
}

/** An app as the registry describes it, as far as reach goes. */
export interface ReachApp {
  slug: string;
  name: string;
  connectorRequirements: readonly Pick<ConnectorRequirement, "name" | "optional" | "access">[];
}

export function connectorReach(opts: {
  connector: Pick<ConnectorManifest, "name" | "telemetry">;
  apps: readonly ReachApp[];
  /** Each app's switch by slug, or null when it couldn't be read. A slug with no row is inactive, as the app gate reads it. */
  active: Readonly<Record<string, boolean>> | null;
  /** An admin switched the connector off: nothing can call it. */
  disabled: boolean;
  /** An admin allowed the connector to change data (src/lib/connectors/writable.ts). */
  changesAllowed: boolean;
  /** Each app's narrowing on this connector, by slug (./app-access.ts). */
  narrowings?: Readonly<Record<string, AppNarrowing>>;
}): ConnectorReach {
  const { connector, active, disabled, changesAllowed } = opts;
  const declared = connector.telemetry ?? [];
  const reads = declared.filter((m) => !m.mutates).map((m) => m.method);
  const writes = declared.filter((m) => m.mutates).map((m) => m.method);

  const apps: AppReach[] = [];
  for (const app of opts.apps) {
    // The schema allows one entry per connector across both lists.
    const need = app.connectorRequirements.find((r) => r.name === connector.name);
    if (!need) continue;
    const narrowing = opts.narrowings?.[app.slug] ?? null;
    const allowed = (m: string) => narrowing?.methods == null || narrowing.methods.includes(m);
    const write: AppWriteReach =
      writes.length === 0
        ? "none"
        : need.access !== "write"
          ? "not-asked"
          : !changesAllowed
            ? "read-only"
            : narrowing?.writes === "deny"
              ? "denied"
              : "allowed";
    const isActive = active === null ? null : active[app.slug] === true;
    const myWrites = write === "allowed" ? writes.filter(allowed) : [];
    apps.push({
      slug: app.slug,
      name: app.name,
      active: isActive,
      optional: need.optional,
      reads: reads.filter(allowed),
      writes: myWrites,
      write,
      canWriteNow: myWrites.length > 0 && isActive !== false && !disabled,
      narrowing,
    });
  }

  const running = (a: AppReach) => a.active !== false;
  apps.sort(
    (a, b) => Number(running(b)) - Number(running(a)) || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
  );

  return {
    apps,
    activityKnown: active !== null,
    runningCount: apps.filter(running).length,
    canWriteCount: apps.filter((a) => a.canWriteNow).length,
    declaresWrites: writes.length > 0,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The tile's line: "Used by 3 active apps · 1 can change data". Null when no
 * app declares the connector, which the tile then says nothing about.
 */
export function describeReach(reach: ConnectorReach): string | null {
  if (reach.apps.length === 0) return null;
  if (reach.runningCount === 0) {
    return `Declared by ${plural(reach.apps.length, "app")}, none of them active`;
  }
  const used = reach.activityKnown
    ? `Used by ${plural(reach.runningCount, "active app")}`
    : `Used by ${plural(reach.apps.length, "app")}`;
  if (!reach.declaresWrites) return used;
  return `${used} · ${reach.canWriteCount === 0 ? "none" : reach.canWriteCount} can change data`;
}

/**
 * One app's row, in words: "Can call 5 methods, 2 of which change data." The
 * pills beside it say whether it runs; this says what it may call.
 */
export function describeAppReach(app: AppReach, declaredWrites: number): string {
  const reads = app.reads.length;
  const total = reads + app.writes.length;
  if (total === 0 && app.narrowing) {
    return "An admin limited it to methods it can't call here, so it can call nothing.";
  }
  if (total === 0 && app.write !== "read-only" && app.write !== "not-asked") {
    return "The connector declares no methods, so it can call nothing.";
  }
  const readsText =
    reads === 0 ? "Can call no method that reads" : `Can call ${plural(reads, "method")} that ${reads === 1 ? "reads" : "read"}`;
  const limited = app.narrowing?.methods ? " An admin limited it to those." : "";
  const theWrites =
    declaredWrites === 1 ? "the method that changes data is" : `the ${declaredWrites} methods that change data are`;
  switch (app.write) {
    case "allowed":
      return app.writes.length === 0
        ? `${readsText}.${limited}`
        : `Can call ${plural(total, "method")}, ${app.writes.length} of which ${app.writes.length === 1 ? "changes" : "change"} data.${limited}`;
    case "read-only":
      return `${readsText}. It asks to change data, and ${theWrites} off while this connector is read-only.${limited}`;
    case "not-asked":
      return `${readsText}. It doesn't ask to change data, so ${theWrites} refused.${limited}`;
    case "denied":
      return `${readsText}. It asks to change data, and an admin took its writes away here.${limited}`;
    case "none":
      return `Can call ${plural(reads, "method")}, none of which changes data.${limited}`;
  }
}
