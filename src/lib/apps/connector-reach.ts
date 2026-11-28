/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isDisabledConnector } from "@/lib/connectors/switch";
import type { ConnectorRequirement } from "@/lib/connectors/requirements";
import type { BaseConnector, ConnectorTelemetryDefinition } from "@/lib/connectors/types";
import { ConnectorChangesNotAllowedError, ConnectorNarrowedError } from "@/lib/connectors/write-policy";
import type { AppNarrowing } from "@/lib/connectors/reach";

/**
 * What a caller can reach on a connector: its declared methods, and nothing
 * else.
 *
 * A connector's manifest lists every public method in `telemetry`, each read
 * or `mutates`, and the build holds the class to that list
 * (scripts/connector-checks.ts). This holds the caller to it. An app gets its
 * connectors through here (src/lib/apps/context.ts), and an MCP tool through
 * the read-only rules in ./read-only.ts.
 *
 *   - A declared read can always be called.
 *   - A declared write can be called when the rules say so: for an app, when
 *     its entry asks for `"access": "write"` and the connector's admin has
 *     allowed changes; for an MCP tool, never.
 *   - Anything else callable is refused. Notably the base class's `request()`,
 *     which is protected to the compiler but reachable with `as any` at
 *     runtime, and sends any verb to any path with the connector's credential.
 *     Also `paginate()`, `initialize()`, `testConnection()` and
 *     `handleWebhook()`, which only the platform calls.
 *
 * Two values pass through, `name` and `configured`, and nothing else does.
 * The connector keeps its decrypted credentials on the instance, in a field
 * that is protected only to the compiler, so a caller handed the instance, or
 * a Proxy whose target is the instance, could read them with a property
 * access, `JSON.stringify`, `Object.entries` or `util.inspect`, and use them
 * past every declaration. So what a caller gets is a facade: a Proxy over an
 * empty object with no prototype, holding the connector only in this
 * function's closure. Its own keys, its prototype and its descriptors are the
 * empty object's, so nothing that walks the object reaches the connector, and
 * it can't be written to.
 *
 * A connector an admin turned off arrives as the context builder's stand-in
 * and is handed on as it is: every call on it already fails with the reason
 * that matters, and it holds no credentials.
 *
 * Kept free of the generated registry so it can be tested on its own: callers
 * pass the declarations in.
 */

/** The members a caller reads as values. Every other non-method reads as undefined. */
const VALUES: ReadonlySet<string> = new Set(["name", "configured"]);

export interface ReachRules {
  /** May the caller run a method declared `mutates`? */
  writes: boolean;
  /** The error for a declared write the caller may not run. */
  refuseWrite: (method: string) => Error;
  /** The error for anything callable the manifest doesn't declare. */
  refuseUndeclared: (member: string) => Error;
  /**
   * The members an admin left this caller (src/lib/connectors/app-access.ts),
   * or undefined for no limit. A declared member outside it is refused with
   * `refuseNarrowed`.
   */
  allows?: (member: string) => boolean;
  /** The error for a declared member the admin's limit leaves out. */
  refuseNarrowed?: (member: string) => Error;
  /**
   * Told of each refused call as it is made, for detection
   * (src/lib/apps/detection.ts): `write` when it was a declared write the
   * caller may not run, `narrowed` when only an admin's limit stopped it,
   * `undeclared` otherwise. Never told of a mere read.
   */
  onRefused?: (member: string, refusal: "write" | "undeclared" | "narrowed") => void;
}

export function narrowConnector(
  connector: BaseConnector,
  declared: readonly ConnectorTelemetryDefinition[],
  rules: ReachRules,
): BaseConnector {
  if (isDisabledConnector(connector)) return connector;

  const reads = new Set(declared.filter((m) => !m.mutates).map((m) => m.method));
  const writes = new Set(declared.filter((m) => m.mutates).map((m) => m.method));
  /** It would be callable but for an admin's limit. */
  const reachable = (member: string) => reads.has(member) || (rules.writes && writes.has(member));
  const callable = (member: string) => reachable(member) && (rules.allows?.(member) ?? true);

  // Read off the connector with the connector as the receiver: its getters
  // read its own private fields, and routing `this` through a proxy turns a
  // working getter into a runtime error.
  const read = (member: string): unknown => Reflect.get(connector, member, connector);

  // Whether `member` is a method of the connector's, decided from its
  // descriptor so that asking never runs one of its getters. A method is a
  // function-valued data property, on the class or, written as an arrow
  // function, on the instance. With no descriptor anywhere, the member is
  // read: that is how a facade this function made answers (the MCP path
  // narrows an app's facade again), and on an instance it is absent anyway.
  const methodOf = (member: string): ((...a: unknown[]) => unknown) | undefined => {
    for (let o: object | null = connector; o !== null; o = Reflect.getPrototypeOf(o)) {
      const d = Reflect.getOwnPropertyDescriptor(o, member);
      if (d) return "value" in d && typeof d.value === "function" ? d.value : undefined;
    }
    const value = read(member);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown) : undefined;
  };

  // One function per member, so `c.listDeals === c.listDeals`.
  const bound = new Map<string, (...args: unknown[]) => unknown>();

  // Extensible, and never written to: the traps below refuse every write. A
  // target that couldn't be extended would make `"listDeals" in c` a
  // TypeError, since a proxy may not report a key its frozen target lacks.
  const empty: object = Object.create(null);

  return new Proxy(empty, {
    get(_empty, prop) {
      // Symbols included: `util.inspect.custom`, `Symbol.toPrimitive` and the
      // like are the connector's to answer only by declaring a method, which
      // a symbol can't be.
      if (typeof prop !== "string") return undefined;
      if (VALUES.has(prop)) return read(prop);

      const method = methodOf(prop);
      // `toString`, `hasOwnProperty` and the like are Object's, not the
      // connector's, and string interpolation reaches for them. Called on
      // the facade, they see the empty object.
      if (method !== undefined && method === Reflect.get(Object.prototype, prop)) return method;

      if (callable(prop) && method !== undefined) {
        let fn = bound.get(prop);
        if (!fn) {
          // Looked up again at call time, as the connector's own code would.
          fn = (...args: unknown[]) => (read(prop) as (...a: unknown[]) => unknown).apply(connector, args);
          bound.set(prop, fn);
        }
        return fn;
      }
      if (reads.has(prop) || writes.has(prop) || method !== undefined) {
        return () => {
          const write = writes.has(prop);
          const narrowed = reachable(prop) && rules.refuseNarrowed !== undefined;
          rules.onRefused?.(prop, narrowed ? "narrowed" : write ? "write" : "undeclared");
          throw narrowed
            ? rules.refuseNarrowed!(prop)
            : write
              ? rules.refuseWrite(prop)
              : rules.refuseUndeclared(prop);
        };
      }
      // A field: credentials, a token, the manifest. Not the caller's.
      return undefined;
    },
    has(_empty, prop) {
      return typeof prop === "string" && (VALUES.has(prop) || reads.has(prop) || writes.has(prop));
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  }) as BaseConnector;
}

/**
 * Thrown when an app calls something its own manifest doesn't allow it: a
 * write its entry didn't ask for, or a member the connector doesn't declare.
 * A bug in the app, for its developer, so it is not a ConnectorError: the
 * route pipeline answers it as an internal error, and the message goes to the
 * server log, where the smoke test's failure points.
 */
export class ConnectorUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorUseError";
  }
}

/**
 * The rules for one app and one of its connectors. A write runs only with
 * both keys: the app's entry asks for "write", and the admin allowed changes.
 * Which key is missing decides the refusal, because each is someone else's to
 * turn: the app's developer, or the connector's admin.
 */
export function appReachRules(opts: {
  appSlug: string;
  connectorName: string;
  subject: string;
  need: Pick<ConnectorRequirement, "access"> | undefined;
  /** Whether the connector's admin allowed changes (src/lib/connectors/writable.ts). */
  writable: boolean;
  /**
   * An admin's narrowing of this app on this connector
   * (src/lib/connectors/app-access.ts), or null for none. `"unknown"` when it
   * couldn't be read: the app gets the connector's reads only, as when Allow
   * changes can't be read.
   */
  narrowing?: AppNarrowing | null | "unknown";
  /**
   * Told of each refused call with why, for detection: an undeclared member,
   * a write the app's entry doesn't ask for, one the admin hasn't allowed, or
   * one an admin's limit for this app leaves out.
   */
  onRefused?: (
    member: string,
    reason: "undeclared" | "write-not-asked" | "write-not-allowed" | "narrowed",
  ) => void;
}): ReachRules {
  const { appSlug, connectorName, subject, need, writable } = opts;
  const asked = need?.access === "write";
  const narrowing = opts.narrowing ?? null;
  // Writes the other two keys would allow, taken away by the admin's limit,
  // or by not knowing it.
  const writesDenied = narrowing === "unknown" || narrowing?.writes === "deny";
  const methods = narrowing !== null && narrowing !== "unknown" ? narrowing.methods : null;
  const narrowedError = () => new ConnectorNarrowedError(connectorName, subject);
  return {
    onRefused: opts.onRefused
      ? (member, refusal) =>
          opts.onRefused!(
            member,
            refusal === "narrowed" || (refusal === "write" && asked && writable && writesDenied)
              ? "narrowed"
              : refusal === "undeclared"
                ? "undeclared"
                : asked
                  ? "write-not-allowed"
                  : "write-not-asked",
          )
      : undefined,
    writes: asked && writable && !writesDenied,
    allows: methods ? (member) => methods.includes(member) : undefined,
    refuseNarrowed: methods ? () => narrowedError() : undefined,
    refuseWrite: (method) =>
      asked && writable && writesDenied
        ? narrowedError()
        : asked
        ? new ConnectorChangesNotAllowedError(connectorName, subject)
        : new ConnectorUseError(
            `apps/${appSlug} called ${connectorName}.${method}(), which changes data, but its app.json entry ` +
              `for ${connectorName} doesn't ask for "access": "write".`,
          ),
    refuseUndeclared: (member) =>
      new ConnectorUseError(
        `apps/${appSlug} called ${connectorName}.${member}(), which connectors/${connectorName}/connector.json ` +
          `doesn't declare. An app calls only a connector's declared methods.`,
      ),
  };
}
