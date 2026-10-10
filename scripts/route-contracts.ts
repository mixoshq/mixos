/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading a route's contract off the `defineRoute()` results its module exports.
 *
 * The registry generator walks `apps/<slug>/api/`, imports each `route.ts` and
 * hands the module to `routeContract` (scanApiRoutes in
 * scripts/generate-project-registry.ts). It lives in a module of its own so a
 * test can run a `defineRoute` fixture through the same code the build uses:
 * scripts/app-smoke.test.ts does, so the smoke test cannot again miss routes
 * that the build records.
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
type HttpMethod = (typeof HTTP_METHODS)[number];

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
      throw new FatalManifestError(
        `apps/${slug}/api/${routePath || "index"}/route.ts: ${method} must be the result of defineRoute({...}). ` +
          `A bare handler declares no input, output, auth or roles, so the gateway cannot validate it, ` +
          `the build cannot check it, and the generated client cannot type it.`,
      );
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
