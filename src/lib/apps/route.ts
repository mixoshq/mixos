/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The app route contract.
 *
 * An app API route is not a function any more — it is a *declaration* that
 * happens to contain one:
 *
 *     export const GET = defineRoute({
 *       auth: ["session"],
 *       roles: ["viewer"],
 *       input: z.object({ limit: z.number().int().max(200).default(50) }),
 *       output: z.object({ items: z.array(Item) }),
 *       budget: { connectorCalls: 20, ms: 8_000 },
 *       handler: async (ctx, input) => ({ items: await load(ctx, input.limit) }),
 *     });
 *
 * WHY A DECLARATION. Everything above the handler has to be readable by
 * something other than the handler: the registry generator hoists it so the
 * build can reject a route that names a role its app never declared; the
 * gateway enforces the auth set and the roles before app code runs; the typed
 * client is generated from the schemas; the admin page shows a human what this
 * app exposes. A raw `export async function GET` can be none of those things,
 * which is why the generator refuses to build one.
 *
 * WHY THE HANDLER RETURNS DATA. It returns a plain object and the pipeline
 * serializes it. That is what deletes the recurring bug class in this
 * codebase's history — a raw `error.message` reaching the browser, a forgotten
 * status code, a handler that returns `undefined` and 200s. A route that
 * genuinely needs to own its Response (a file stream, a redirect) declares
 * `raw: true`, and that shows up in review as the exception it is.
 *
 * WHAT AN OMITTED `input` MEANS. Not "unvalidated" — *unavailable*. A route
 * with no `input` schema receives `{}`, and anything the caller sent is
 * discarded before the handler sees it. An agent that forgets the schema gets a
 * handler that cannot read its own parameters, which fails in the first test
 * rather than quietly accepting whatever arrives.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { AppContext, PublicAppContext } from "@/lib/hooks/types";
import {
  ALL_ROUTE_AUTHS,
  ANONYMOUS_AUTHS,
  type RouteAuth,
} from "@/lib/apps/types";
import type { BaseConnector } from "@/lib/connectors/types";
import { AppError, toErrorResponse } from "@/lib/apps/errors";
import { withTimeout } from "@/lib/timeout";
import { recordRouteCall } from "@/lib/apps/telemetry";

// ============================================================
// Declaration types
// ============================================================

/**
 * Re-exported from `types.ts`, which is the pure-type module the build scripts
 * import. `RouteAuth` has to be readable by the registry generator, and the
 * generator must not pull in this module's `next/server` dependency.
 */
export type { RouteAuth };
export { ALL_ROUTE_AUTHS, ANONYMOUS_AUTHS };

/**
 * Re-exported so an app author has ONE import for the whole route contract.
 * `defineRoute` and `AppError` are used together in essentially every handler;
 * making them two imports from two modules is the kind of friction that gets
 * worked around with a hand-rolled `NextResponse.json({error}, {status: 404})`.
 */
export { AppError, isAppError } from "@/lib/apps/errors";
export type { AppErrorCode } from "@/lib/apps/errors";

/**
 * Per-route ceilings.
 *
 * `ms` bounds how long the caller waits. It does NOT stop the handler — see the
 * warning on `withTimeout`. `connectorCalls` is the one that bounds actual
 * spend: every method call on `ctx.connectors.*` is counted, and the route
 * fails once it passes the cap rather than fanning out unboundedly.
 */
export interface RouteBudget {
  /** Maximum method calls across all of `ctx.connectors`. */
  connectorCalls?: number;
  /** Maximum wall-clock milliseconds before the caller gets a 504. */
  ms?: number;
}

/**
 * A route that fans out more than this is almost always an N+1 that was meant
 * to be a batch read — the failure mode `docs/apps/api-routes.md` devotes a
 * whole section to. Generous enough that a legitimately wide route clears it,
 * low enough that a per-record loop over a full book does not. Raise it
 * explicitly in the route's own `budget` when the fan-out is intended.
 */
const DEFAULT_CONNECTOR_CALLS = 100;

/**
 * Every route gets a wall-clock ceiling whether it asks for one or not. A
 * handler that hangs on an upstream with no timeout of its own would otherwise
 * hold the connection until the platform's own function timeout kills it, with
 * nothing in the response to say what happened.
 */
const DEFAULT_BUDGET_MS = 30_000;

/**
 * ~5 MB serialized, matching the App Services broker. A route backs a UI, and
 * some UI payloads are genuinely large; what this stops is an unbounded one.
 */
const MAX_PAYLOAD_CHARS = 5_000_000;

/**
 * The context handed to a handler that resolved to an identity-carrying tier.
 * `auth` says which one, so a route serving both a member and a stranger can
 * branch on the fact rather than inferring it from `user !== null`.
 */
export type AuthedContext = AppContext & { auth: "session" | "signed-in" };

/** The context for a tier that carries no identity. `user` is `null`. */
export type AnonContext = PublicAppContext & {
  auth: "password" | "key" | "public";
};

export type ResolvedContext = AuthedContext | AnonContext;

/**
 * The context a handler receives, derived from its declared auth set. Declaring
 * any anonymous auth widens `ctx.user` to `AppContextUser | null`, so the
 * compiler — not a code reviewer — is what makes the handler cover the
 * signed-out branch.
 */
export type ContextFor<A extends readonly RouteAuth[]> = [
  Extract<A[number], "password" | "key" | "public">,
] extends [never]
  ? AuthedContext
  : ResolvedContext;

interface BaseRouteSpec<A extends readonly RouteAuth[]> {
  /** Accepted auths. Defaults to `["session"]`. */
  auth?: A;
  /**
   * Role keys, any of which satisfies the route. Enforced by the gateway before
   * the handler runs, and cross-checked at build time against the app's declared
   * `roles`. Use `ctx.user.hasRole()` inside the handler for finer branching —
   * which fields to include — not for the gate itself.
   */
  roles?: string[];
  budget?: RouteBudget;
  /** One line, for the admin surface and the generated client's doc comment. */
  summary?: string;
}

/**
 * The parsed input a handler receives: the schema's OUTPUT, with defaults
 * applied and transforms run. `Record<string, never>` when no schema is
 * declared, because an undeclared input is unavailable rather than unvalidated.
 */
export type ParsedInput<S> = S extends z.ZodType
  ? z.output<S>
  : Record<string, never>;

/**
 * The input a CALLER sends: the schema's INPUT, where a field with a default is
 * optional. Distinct from `ParsedInput` on purpose — a route declaring
 * `limit: z.number().default(10)` must not force every caller to pass a limit
 * just because its handler is guaranteed one.
 */
export type WireInput<S> = S extends z.ZodType
  ? z.input<S>
  : Record<string, never>;

export interface JsonRouteSpec<
  S,
  TOut,
  A extends readonly RouteAuth[] = ["session"],
> extends BaseRouteSpec<A> {
  raw?: false;
  input?: S;
  /**
   * Validated on every response, in every environment. The parse is also what
   * strips keys the schema does not declare, so it is never skipped; there used
   * to be a `{ schema, validate: "dev-only" }` form, removed with its escape in
   * docs/plans/20261005_2150-app-escapes.md.
   */
  output: z.ZodType<TOut>;
  handler: (ctx: ContextFor<A>, input: ParsedInput<S>) => TOut | Promise<TOut>;
}

export interface RawRouteSpec<S, A extends readonly RouteAuth[] = ["session"]>
  extends BaseRouteSpec<A> {
  /**
   * This route owns its own Response — a file stream, a redirect, a non-JSON
   * body. Output validation and the payload cap are both skipped, and the
   * timeout only covers producing the Response, not consuming its body.
   */
  raw: true;
  input?: S;
  handler: (
    ctx: ContextFor<A>,
    input: ParsedInput<S>,
    request: Request,
  ) => Response | Promise<Response>;
}

/** Runtime brand. `Symbol.for` so it survives two copies of this module. */
export const ROUTE_DEFINITION = Symbol.for("mos.route.definition");

/**
 * The hoisted, inspectable form of a route. The generator reads the plain
 * fields; the gateway and `context.call()` both dispatch through `runRoute`.
 */
export interface RouteDefinition<S = unknown, TOut = unknown> {
  readonly brand: typeof ROUTE_DEFINITION;
  readonly auth: RouteAuth[];
  readonly roles: string[];
  readonly budget: Required<RouteBudget>;
  readonly summary?: string;
  readonly raw: boolean;
  readonly input?: z.ZodType;
  readonly output?: z.ZodType;
  readonly handler: (
    ctx: never,
    input: never,
    request: Request,
  ) => unknown | Promise<unknown>;
  /**
   * Phantom. Never assigned, erased at runtime, and present only so that
   * `typeof GET` carries the shapes the route declared.
   *
   * This is what makes the generated client typed. `defineRoute` knows `TIn`
   * and `TOut` from the Zod schemas, but a non-generic `RouteDefinition` would
   * throw both away at the export boundary, leaving the client with nothing to
   * infer from and `client.call()` no better than the `get<T>()` assertion it
   * replaces.
   */
  readonly __types?: { schema: S; output: TOut };
}

/** What a CALLER passes — the schema's input side, so defaults stay optional. */
export type RouteInputOf<D> =
  D extends RouteDefinition<infer S, unknown> ? WireInput<S> : never;

/** The data a route resolves to. */
export type RouteOutputOf<D> =
  D extends { __types?: { output: infer TOut } } ? TOut : never;

function normalizeCap(declared: number | undefined, fallback: number): number {
  if (declared === undefined) return fallback;
  if (!Number.isFinite(declared) || declared < 0) {
    throw new Error(
      `defineRoute: budget values must be finite and non-negative; got ${declared}.`,
    );
  }
  return declared;
}

export function defineRoute<
  TOut,
  A extends readonly RouteAuth[] = ["session"],
  S extends z.ZodType | undefined = undefined,
>(spec: JsonRouteSpec<S, TOut, A>): RouteDefinition<S, TOut>;
export function defineRoute<
  A extends readonly RouteAuth[] = ["session"],
  S extends z.ZodType | undefined = undefined,
>(spec: RawRouteSpec<S, A>): RouteDefinition<S, Response>;
export function defineRoute(
  spec:
    | JsonRouteSpec<z.ZodType | undefined, unknown, readonly RouteAuth[]>
    | RawRouteSpec<z.ZodType | undefined, readonly RouteAuth[]>,
): RouteDefinition {
  const raw = spec.raw === true;
  const output = raw
    ? undefined
    : (spec as JsonRouteSpec<z.ZodType | undefined, unknown, readonly RouteAuth[]>)
        .output;

  // TypeScript already refuses anything but a schema; this is for a route that
  // reached here without it, so the mistake surfaces when the route is defined
  // (which the generator does at build time) rather than on its first request.
  if (output !== undefined && typeof (output as { safeParse?: unknown }).safeParse !== "function") {
    throw new Error(
      "defineRoute: `output` must be a Zod schema. The `{ schema, validate }` form was removed — output is validated on every response.",
    );
  }

  return {
    brand: ROUTE_DEFINITION,
    auth: [...(spec.auth ?? ["session"])],
    roles: [...(spec.roles ?? [])],
    budget: {
      // `0` is a legitimate declaration meaning "this route calls no
      // connectors", so it must survive `??` and reach the counter — which
      // rejects the first call. A negative value is a typo, not a stricter
      // cap, and would silently read as unlimited.
      connectorCalls: normalizeCap(spec.budget?.connectorCalls, DEFAULT_CONNECTOR_CALLS),
      ms: normalizeCap(spec.budget?.ms, DEFAULT_BUDGET_MS),
    },
    ...(spec.summary ? { summary: spec.summary } : {}),
    raw,
    ...(spec.input ? { input: spec.input as z.ZodType } : {}),
    ...(output ? { output: output as z.ZodType } : {}),
    handler: spec.handler as RouteDefinition["handler"],
  };
}

export function isRouteDefinition(value: unknown): value is RouteDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { brand?: unknown }).brand === ROUTE_DEFINITION
  );
}

// ============================================================
// Input assembly
// ============================================================

/**
 * Query strings are all strings; a schema declaring `limit: z.number()` would
 * reject `"20"` for a request that is entirely well-formed. The MCP broker
 * never had this problem — its arguments arrive as typed JSON — so there is no
 * precedent to copy, and the alternative (making every app author remember
 * `z.coerce`) is exactly the kind of thing an unreviewed agent forgets.
 *
 * So the pipeline coerces, driven by the schema's own declared field types. It
 * walks one level of the object shape, unwrapping the wrappers that do not
 * change the underlying type, and converts only where the target is
 * unambiguous. Anything it cannot read, it leaves alone for Zod to reject.
 */
/** Wrappers that change a field's cardinality or default, never its base type. */
const TRANSPARENT_WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

/** Peel the transparent wrappers off a schema node and return the node itself. */
function unwrapSchema(schema: unknown, depth = 0): unknown {
  if (depth > 8 || typeof schema !== "object" || schema === null) return schema;
  const def = (schema as { def?: { type?: string; innerType?: unknown } }).def;
  if (!def || typeof def.type !== "string") return schema;
  if (TRANSPARENT_WRAPPERS.has(def.type) && def.innerType) {
    return unwrapSchema(def.innerType, depth + 1);
  }
  return schema;
}

function innerTypeName(schema: unknown): string | undefined {
  const def = (unwrapSchema(schema) as { def?: { type?: string } } | null)?.def;
  return typeof def?.type === "string" ? def.type : undefined;
}

function coerceScalar(value: string, target: string | undefined): unknown {
  if (target === "number") {
    const n = Number(value);
    // An unparseable number is left as the original string so Zod reports
    // "expected number, received string" against the value the caller sent,
    // rather than a NaN the caller never wrote.
    return value.trim() !== "" && Number.isFinite(n) ? n : value;
  }
  if (target === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  if (target === "bigint") {
    try {
      return BigInt(value);
    } catch {
      return value;
    }
  }
  return value;
}

function coerceQueryInput(
  schema: z.ZodType | undefined,
  raw: Record<string, string | string[]>,
): Record<string, unknown> {
  const shape = (schema as { def?: { shape?: Record<string, unknown> } } | undefined)?.def?.shape;
  if (!shape) return raw;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = shape[key];
    if (!field) {
      out[key] = value;
      continue;
    }
    const target = innerTypeName(field);
    if (target === "array") {
      // Read `element` off the UNWRAPPED node: for `z.array(z.number()).optional()`
      // the declared field is the optional wrapper, which has no `element` of its
      // own, and reading through it silently skipped every array coercion.
      const element = (unwrapSchema(field) as { def?: { element?: unknown } }).def
        ?.element;
      const elementTarget = innerTypeName(element);
      const items = Array.isArray(value) ? value : [value];
      out[key] = items.map((v) => coerceScalar(v, elementTarget));
      continue;
    }
    out[key] = Array.isArray(value)
      ? value.map((v) => coerceScalar(v, target))
      : coerceScalar(value, target);
  }
  return out;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

async function assembleInput(
  def: RouteDefinition,
  request: Request,
  pathParams: Record<string, string>,
): Promise<unknown> {
  // No declared schema means no input reaches the handler. See the module note.
  if (!def.input) return {};

  const method = request.method.toUpperCase();

  // A raw route is handed the Request itself and reads its own body — reading
  // it here would drain the stream and hand the handler an already-consumed
  // request, which is the one thing a raw route exists to avoid. Its declared
  // input therefore covers the query string and path params only.
  if (def.raw) {
    return { ...coerceQueryInput(def.input, queryOf(request)), ...coerceStrings(def.input, pathParams) };
  }

  if (BODY_METHODS.has(method)) {
    let body: unknown = {};
    const text = await request.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw AppError.invalidInput("Request body is not valid JSON.");
      }
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw AppError.invalidInput("Request body must be a JSON object.");
    }
    // Path params are raw strings even on a body request, so they need the same
    // coercion the query string gets. They are merged LAST because the URL is
    // the more specific statement about which record is being addressed.
    return {
      ...(body as Record<string, unknown>),
      ...coerceStrings(def.input, pathParams),
    };
  }

  return {
    ...coerceQueryInput(def.input, queryOf(request)),
    ...coerceStrings(def.input, pathParams),
  };
}

function queryOf(request: Request): Record<string, string | string[]> {
  const url = new URL(request.url);
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    raw[key] = all.length > 1 ? all : all[0];
  }
  return raw;
}

/**
 * Coerce a bag of raw strings (dynamic path segments) against the schema.
 *
 * A path segment is exactly as much a string as a query parameter, and skipping
 * it meant a route declaring `input: z.object({ id: z.number() })` for
 * `items/[id]` could never validate — the one shape where the parameter name is
 * fixed by the filesystem and the author has no chance to notice.
 */
function coerceStrings(
  schema: z.ZodType | undefined,
  values: Record<string, string>,
): Record<string, unknown> {
  return coerceQueryInput(schema, values);
}

// ============================================================
// Connector budget
// ============================================================

/**
 * Count every connector method call and fail the route once it passes its cap.
 *
 * The proxy uses `target` as the `get` receiver rather than the proxy itself.
 * That is deliberate: a connector's `get configured()` reads its own private
 * fields, and routing `this` back through the proxy is the classic way to turn
 * a working getter into a runtime error.
 */
function withConnectorBudget(
  connectors: Record<string, BaseConnector>,
  max: number,
  label: string,
): Record<string, BaseConnector> {
  const state = { used: 0 };
  const wrapped: Record<string, BaseConnector> = {};

  for (const [name, connector] of Object.entries(connectors)) {
    wrapped[name] = new Proxy(connector, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          state.used += 1;
          if (state.used > max) {
            throw AppError.budgetExceeded(
              `${label} exceeded its connector-call budget of ${max}. This is almost always a per-record loop that wants to be a batch read — see docs/apps/api-routes.md. Raise the route's budget only when the fan-out is intended.`,
              { budget: "connectorCalls", limit: max, connector: name, method: String(prop) },
            );
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as BaseConnector;
  }

  return wrapped;
}

// ============================================================
// The pipeline
// ============================================================

export interface RunRouteOptions {
  context: ResolvedContext;
  appSlug: string;
  /**
   * The route's on-disk PATTERN — `items/[id]`, not `items/42`.
   *
   * Load-bearing for telemetry: the pattern's key space is exactly the app's
   * declared route set, finite and known at build time. The URL values are
   * caller-controlled and unbounded, so grouping on them would let anyone mint
   * unlimited distinct event names.
   */
  routePattern: string;
  method: string;
  /** Values for the route's dynamic segments, e.g. `{ id: "42" }`. */
  pathParams?: Record<string, string>;
  /**
   * Input supplied directly rather than parsed out of the request.
   *
   * The in-process transport has a real object already and should not have to
   * flatten it into a query string just so the pipeline can parse it back —
   * that round trip is exactly what loses the types the caller had. Validation
   * still runs against it, so this is a shortcut past *parsing*, never past the
   * schema.
   */
  inputOverride?: unknown;
}

/** `my-app GET /items/[id]` — built here so the log label and the telemetry
 *  event name are the same string and cannot drift. */
function labelFor(appSlug: string, method: string, routePattern: string): string {
  return `${appSlug} ${method} /${routePattern}`;
}

/**
 * The route pipeline itself, shared by every transport.
 *
 * Throws `AppError` on any failure and returns either the validated payload or,
 * for a `raw` route, the Response the handler produced. It does not build an
 * HTTP response and it does not record telemetry — those belong to the caller,
 * because they differ between the wire and an in-process call.
 *
 * The order is the same one both existing brokers use, and it is load-bearing:
 * authorize, validate, then run under budget, then check what came back. See
 * `src/lib/mcp/broker.ts` for the original.
 */
async function executeRoute(
  def: RouteDefinition,
  request: Request,
  context: ResolvedContext,
  pathParams: Record<string, string>,
  label: string,
  inputOverride?: unknown,
): Promise<{ kind: "raw"; response: Response } | { kind: "data"; payload: unknown }> {
  // ROLES, ENFORCED HERE RATHER THAN AT THE MOUNT. This is the single place
  // every caller passes through — both HTTP mounts and the in-process
  // `callAppRoute` — so a route's role gate cannot be reachable by a path that
  // forgot to check it. Default-deny: a declared role that nobody satisfies is
  // a 403, never a fall-through.
  //
  // `isAdmin` deliberately does NOT bypass. App roles are app-local, and the
  // platform admin flag says nothing about what an app's "approver" means. This
  // matches `hasRole`'s documented purity — an app that wants admins to bypass
  // grants them the role.
  //
  // The build additionally rejects `roles` on any auth set but `["session"]`,
  // since no other tier carries roles; this check is what makes that guarantee
  // true at runtime rather than merely at build time.
  if (def.roles.length > 0) {
    if (!context.user) {
      throw AppError.forbidden("This requires a signed-in user with a role.");
    }
    if (!context.user.hasRole(def.roles)) {
      throw AppError.forbidden();
    }
  }

  const assembled =
    inputOverride !== undefined
      ? { ...(inputOverride as Record<string, unknown>), ...pathParams }
      : await assembleInput(def, request, pathParams);

  let input: unknown = {};
  if (def.input) {
    const parsed = def.input.safeParse(assembled);
    if (!parsed.success) {
      throw AppError.invalidInput(
        `Invalid request for ${label}.`,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    input = parsed.data;
  }

  // Always wrapped. A cap of 0 means "no connector calls", and the counter
  // rejects the first one; skipping the proxy at 0 would make the strictest
  // declaration an author can write the only unbounded one.
  const ctx = {
    ...context,
    connectors: withConnectorBudget(
      context.connectors,
      def.budget.connectorCalls,
      label,
    ),
  };

  const handler = def.handler as (
    c: unknown,
    i: unknown,
    r: Request,
  ) => unknown | Promise<unknown>;

  const result = await withTimeout(
    Promise.resolve(handler(ctx, input, request)),
    def.budget.ms,
    () =>
      AppError.timeout(
        `${label} did not finish within its ${def.budget.ms}ms budget.`,
      ),
  );

  // A raw route owns its Response: no output schema, no payload cap, and the
  // timeout above only covered producing it.
  if (def.raw) {
    if (!(result instanceof Response)) {
      throw new AppError(
        "INVALID_OUTPUT",
        `${label} declares \`raw: true\` but did not return a Response.`,
      );
    }
    return { kind: "raw", response: result };
  }

  if (result instanceof Response) {
    throw new AppError(
      "INVALID_OUTPUT",
      `${label} returned a Response without declaring \`raw: true\`.`,
    );
  }

  if (!def.output) return { kind: "data", payload: result };

  const parsed = def.output.safeParse(result);
  // The parse is also what strips keys the schema does not declare, so it is
  // the parsed data — never the raw result — that goes out.
  if (parsed.success) return { kind: "data", payload: parsed.data };

  // Logged, because safeErrorMessage never logs and in production the caller
  // only sees the generic message. Without this an output mismatch is invisible
  // on the server.
  console.error(
    `[route] ${label} returned a payload that failed its own output schema:`,
    parsed.error.issues,
  );

  throw new AppError(
    "INVALID_OUTPUT",
    `${label} returned data that does not match its declared output.`,
    process.env.NODE_ENV === "production"
      ? undefined
      : parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
  );
}

/**
 * Telemetry for one route invocation, shared by both transports.
 *
 * Returned as a closure rather than inlined so the success and failure paths
 * cannot drift, and fired with `void` because telemetry never blocks or fails a
 * request.
 */
function routeRecorder(
  appSlug: string,
  method: string,
  routePattern: string,
  context: ResolvedContext,
) {
  const startedAt = Date.now();
  return (status: number, overBudget?: "timeout" | "connector-budget") => {
    void recordRouteCall({
      appSlug,
      // The PATTERN, not the URL. See recordRouteCall for why this matters.
      eventName: `${method} /${routePattern}`,
      userId: context.user?.id ?? null,
      tier: context.auth,
      status,
      durationMs: Date.now() - startedAt,
      ...(overBudget ? { overBudget } : {}),
    });
  };
}

/** Which budget a failure blew, for telemetry. */
function budgetFrom(err: unknown): "timeout" | "connector-budget" | undefined {
  if (!(err instanceof AppError)) return undefined;
  if (err.code === "TIMEOUT") return "timeout";
  if (err.code === "BUDGET_EXCEEDED") return "connector-budget";
  return undefined;
}

/**
 * Run a declared route and produce its HTTP Response. Used by both mounts.
 *
 * Never throws: every failure becomes a Response, which is the contract the
 * gateway depends on.
 */
export async function runRoute(
  def: RouteDefinition,
  request: Request,
  {
    context,
    appSlug,
    routePattern,
    method,
    pathParams = {},
    inputOverride,
  }: RunRouteOptions,
): Promise<Response> {
  const label = labelFor(appSlug, method, routePattern);
  const record = routeRecorder(appSlug, method, routePattern, context);

  try {
    const out = await executeRoute(
      def,
      request,
      context,
      pathParams,
      label,
      inputOverride,
    );

    if (out.kind === "raw") {
      // For a raw route this measures time-to-Response, not time-to-last-byte:
      // the handler produced a stream and the body is still being consumed.
      record(out.response.status);
      return out.response;
    }

    if (out.payload === undefined) {
      record(204);
      return new NextResponse(null, { status: 204 });
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(out.payload);
    } catch {
      throw new AppError(
        "HANDLER_ERROR",
        `${label} returned a value that cannot be serialized.`,
      );
    }
    if (serialized.length > MAX_PAYLOAD_CHARS) {
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        `${label} returned too much data (${Math.round(serialized.length / 1024)} KB). Narrow it with a filter or a smaller limit.`,
      );
    }

    record(200);
    return new NextResponse(serialized, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    if (!(err instanceof AppError)) {
      console.error(`[route] ${label} threw:`, err);
    }
    const { status, body } = toErrorResponse(err, `${label} failed.`);
    record(status, budgetFrom(err));
    try {
      return NextResponse.json(body, { status });
    } catch {
      // `details` is app-supplied (Zod issues, but also whatever an author put
      // in an AppError). A BigInt or a circular reference in there would throw
      // out of the one function whose contract is "always returns a Response".
      console.error(`[route] ${label}: error details were not serializable.`);
      return NextResponse.json({ error: body.error, code: body.code }, { status });
    }
  }
}

/**
 * Run a declared route and return its data, with no HTTP in the middle.
 *
 * The in-process transport behind `callAppRoute`. Identical pipeline —
 * same roles, same input validation, same budget, same output validation, same
 * telemetry — so a server component rendering from its own route gets exactly
 * what a browser calling that route would get, minus a network hop and a
 * serialize/parse round trip.
 *
 * Unlike `runRoute` this THROWS `AppError`, because a caller holding real data
 * wants a real exception, not a Response it has to unpack.
 *
 * The payload cap does not apply: it bounds what crosses the wire, and nothing
 * crosses one here. A `raw` route is refused — its whole purpose is a Response.
 */
export async function runRouteData<TOut = unknown>(
  def: RouteDefinition,
  request: Request,
  {
    context,
    appSlug,
    routePattern,
    method,
    pathParams = {},
    inputOverride,
  }: RunRouteOptions,
): Promise<TOut> {
  const label = labelFor(appSlug, method, routePattern);
  const record = routeRecorder(appSlug, method, routePattern, context);

  try {
    const out = await executeRoute(
      def,
      request,
      context,
      pathParams,
      label,
      inputOverride,
    );
    if (out.kind === "raw") {
      throw new AppError(
        "INVALID_OUTPUT",
        `${label} declares \`raw: true\` and can only be called over HTTP.`,
      );
    }
    record(200);
    return out.payload as TOut;
  } catch (err) {
    if (!(err instanceof AppError)) {
      console.error(`[route] ${label} threw:`, err);
    }
    const { status } = toErrorResponse(err, `${label} failed.`);
    record(status, budgetFrom(err));
    throw err;
  }
}
