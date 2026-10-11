/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading a route's contract off the `defineRoute()` results its module exports.
 *
 * The registry generator walks `apps/<slug>/api/`, imports each `route.ts` and
 * hands the module to `routeContract` (importRouteContracts in
 * scripts/generate-project-registry.ts). It lives in a module of its own so a
 * test can run a `defineRoute` fixture through the same code the build uses:
 * scripts/app-smoke.test.ts does, so the smoke test cannot again miss routes
 * that the build records.
 *
 * Three of the rules the build holds a route to are also here as functions of
 * their own: a bare handler, a role the app does not declare, and `raw: true`
 * without its escape. An install's check judges the same three by reading each
 * route's source (scripts/route-reader.ts), and both ends call these, so a
 * route the check refuses is refused for the rule, and in the words, the build
 * uses.
 */

import type {
  RouteAuth,
  RouteContract,
  RouteMethodContract,
} from "../src/lib/apps/types";
import { FatalManifestError } from "./manifest-errors";

/**
 * The brand `defineRoute()` stamps on its result.
 *
 * Duck-typed against the global symbol registry rather than imported from
 * `src/lib/apps/route.ts`, so the generator never pulls `next/server` into a
 * build script. `Symbol.for` is registry-backed, so the comparison holds across
 * module instances.
 */
const ROUTE_BRAND = Symbol.for("mixos.route.definition");

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A route's file as messages name it: `apps/<slug>/api/<path>/route.ts`, `index` for the root. */
export function routeFileName(slug: string, routePath: string): string {
  return `apps/${slug}/api/${routePath || "index"}/route.ts`;
}

/** The refusal of a method exported as anything but a `defineRoute()` result. */
export function bareHandlerProblem(slug: string, routePath: string, method: string): string {
  return (
    `${routeFileName(slug, routePath)}: ${method} must be the result of defineRoute({...}). ` +
    `A bare handler declares no input, output, auth or roles, so the gateway cannot validate it, ` +
    `the build cannot check it, and the generated client cannot type it.`
  );
}

/**
 * One refusal for each role `method` requires that the app does not declare,
 * in the order the route names them. A role no user can hold gates the route
 * on nothing anyone has: a silent 403 forever.
 */
export function undeclaredRoleProblems(
  slug: string,
  routePath: string,
  method: string,
  roles: readonly string[],
  declared: readonly { key: string }[],
): string[] {
  const keys = new Set(declared.map((r) => r.key));
  return roles
    .filter((role) => !keys.has(role))
    .map(
      (role) =>
        `${routeFileName(slug, routePath)}: ${method} requires role "${role}", ` +
        `which the app does not declare in \`roles\`. No user can ever hold it, so the route would 403 forever.`,
    );
}

/** Whether `app.json` declares the escape a `raw: true` route needs. */
export function declaresRawResponse(escapes: readonly { rule: string }[]): boolean {
  return escapes.some((e) => e.rule === "raw-response");
}

/** One method of one route that sets `raw: true`. */
export interface RawMethod {
  routePath: string;
  method: string;
}

/**
 * The refusal of an app whose routes set `raw: true` without the raw-response
 * escape, or null when there is none to make. `message` is the line the build
 * prints, naming every such route; `problems` is the same refusal once per
 * route, naming its file, for an install's verdict.
 */
export function rawResponseRefusal(
  slug: string,
  raw: readonly RawMethod[],
  escapes: readonly { rule: string }[],
): { message: string; problems: string[] } | null {
  if (raw.length === 0 || declaresRawResponse(escapes)) return null;
  const needs = `(\`raw: true\`), which needs { "rule": "raw-response", "reason": "…" } under \`escapes\` in app.json.`;
  const named = raw.map((m) => `${m.method} /${m.routePath}`);
  return {
    message: `${named.join(", ")} ${named.length === 1 ? "returns its" : "return their"} own Response ${needs}`,
    problems: raw.map((m) => `${routeFileName(slug, m.routePath)}: ${m.method} returns its own Response ${needs}`),
  };
}

/** The shape `defineRoute()` returns, as far as the generator needs to read it. */
interface RawRouteDefinition {
  brand: symbol;
  auth: RouteAuth[];
  roles: string[];
  budget: { connectorCalls: number; ms: number };
  raw: boolean;
  input?: unknown;
  output?: unknown;
  summary?: string;
}

function isRawRouteDefinition(v: unknown): v is RawRouteDefinition {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { brand?: unknown }).brand === ROUTE_BRAND
  );
}

/** `items/[id]/notes` → `["id"]`. Catch-alls (`[...rest]`) yield `rest`. */
export function paramsForPath(routePath: string): string[] {
  if (!routePath) return [];
  return routePath
    .split("/")
    .filter((seg) => seg.startsWith("[") && seg.endsWith("]"))
    .map((seg) =>
      seg
        .slice(1, -1)
        .replace(/^\.\.\./, "")
        .replace(/^\[|\]$/g, ""),
    );
}

/**
 * The contract of one imported `route.ts`: app `slug`, at `routePath` (POSIX,
 * relative to `api/`, `""` for `api/index/route.ts`).
 *
 * Throws FatalManifestError for an exported method that is not a
 * `defineRoute()` result, a JSON route with no `output`, or a module exporting
 * no method at all.
 */
export function routeContract(
  slug: string,
  routePath: string,
  mod: Record<string, unknown>,
): RouteContract {
  const methods: RouteMethodContract[] = [];
  for (const method of HTTP_METHODS) {
    const exported = mod[method];
    if (exported === undefined) continue;

    if (!isRawRouteDefinition(exported)) {
      throw new FatalManifestError(bareHandlerProblem(slug, routePath, method));
    }

    if (!exported.raw && !exported.output) {
      throw new FatalManifestError(
        `apps/${slug}/api/${routePath || "index"}/route.ts: ${method} declares no \`output\` schema. ` +
          `Declare one, or set \`raw: true\` if the route owns its own Response.`,
      );
    }

    methods.push({
      method: method as HttpMethod,
      auth: exported.auth,
      roles: exported.roles,
      budget: exported.budget,
      raw: exported.raw,
      hasInput: exported.input != null,
      hasOutput: exported.output != null,
      ...(exported.summary ? { summary: exported.summary } : {}),
    });
  }

  if (methods.length === 0) {
    throw new FatalManifestError(
      `apps/${slug}/api/${routePath || "index"}/route.ts exports no HTTP method. ` +
        `Export at least one of ${HTTP_METHODS.join(", ")} as a defineRoute({...}) result, or delete the file.`,
    );
  }

  return {
    path: routePath,
    params: paramsForPath(routePath),
    methods,
  };
}
