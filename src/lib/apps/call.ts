/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Calling an app's own route from a server component, without HTTP.
 *
 * A server page must not import `lib/server`, a connector, or the database —
 * that was the second authorization surface Phase 1 existed to delete. But
 * banning it would also delete server rendering, because the page would have
 * nowhere to get its data. This is the way back:
 *
 * ```tsx
 * // apps/my-app/pages/Main.tsx  (a server component)
 * import { callAppRoute } from "@/lib/apps/call";
 *
 * export default async function Page() {
 *   const { items } = await callAppRoute("my-app", "GET /items", { limit: 20 });
 *   return <ItemsTable rows={items} />;
 * }
 * ```
 *
 * Same pipeline as the wire: the app gate before the route is imported, the
 * same auth-tier resolution against the page's own session, the same role
 * gate, the same input and output validation, the same connector budget, the
 * same telemetry row. What it skips is the network, the JSON round trip, and
 * the rate limiters — the last deliberately, because the page render is
 * already bounded by the request that triggered it, and charging a user's API
 * budget twice for one page view would make a dashboard throttle itself.
 *
 * It THROWS `AppError` rather than returning a Response. A page that wants to
 * degrade rather than fail should catch it.
 *
 * ITS OWN ROUTES ONLY, AND THE BUILD SAYS SO. Nothing here checks which app is
 * calling: given another app's slug, this runs that app's routes, mutations
 * included, as the current user, around the consent App Services requires. The
 * registry generator's containment scan closes that before any request: app
 * code may call `callAppRoute` only directly, with its own slug as a string
 * literal, and no other use of the binding passes (src/lib/apps/
 * import-policy.mjs). Platform code calling this is trusted to pass the right
 * slug.
 */

import { appRegistry } from "@/generated/app-registry";
import { checkAppGate } from "@/lib/apps/app-gate";
import { AppError } from "@/lib/apps/errors";
import { buildAppContext, buildPublicAppContext } from "@/lib/apps/context";
import { resolveAuthTier } from "@/lib/apps/auth-tier";
import {
  isRouteDefinition,
  runRouteData,
  type ResolvedContext,
  type RouteDefinition,
} from "@/lib/apps/route";
import { loadRouteModule } from "@/lib/apps/route-loader";
import { routeModulePath } from "@/lib/apps/route-modules";
import { getAppOrigin } from "@/lib/env/origin";
import { APP_UPDATING_MESSAGE } from "@/lib/platform/maintenance-gate";
import { deepFreeze } from "./freeze";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * `"GET /items/[id]"` → `{ method, pattern }`.
 *
 * The pattern is the on-disk one, with `[id]` left in place, because that is the
 * key the registry and the telemetry event name both use. Values travel in
 * `input`, not in the spec string — which is also why an in-process call cannot
 * accidentally mint a high-cardinality event name.
 */
function parseSpec(spec: string): { method: string; pattern: string } {
  const [method, rawPath] = spec.split(" ");
  if (!method || !METHODS.has(method) || rawPath === undefined) {
    throw new AppError(
      "NOT_FOUND",
      `"${spec}" is not a route spec. Expected "<METHOD> /<path>", e.g. "GET /items/[id]".`,
    );
  }
  return { method, pattern: rawPath.replace(/^\/+/, "").replace(/\/+$/, "") };
}

export async function callAppRoute<TOut = unknown>(
  appSlug: string,
  spec: string,
  input?: Record<string, unknown>,
): Promise<TOut> {
  const { method, pattern } = parseSpec(spec);

  const manifest = appRegistry.find((a) => a.slug === appSlug);
  if (!manifest) throw new AppError("NOT_FOUND", `No app "${appSlug}".`);

  // Resolved against the hoisted contract, so a typo in the spec is a clear
  // error naming the route rather than a module-not-found deep in a dynamic
  // import.
  const contract = manifest.routes?.find((r) => r.path === pattern);
  const methodContract = contract?.methods.find((m) => m.method === method);
  if (!methodContract) {
    throw new AppError(
      "NOT_FOUND",
      `"${appSlug}" declares no route "${spec}". Declared: ${
        (manifest.routes ?? [])
          .flatMap((r) => r.methods.map((m) => `${m.method} /${r.path}`))
          .join(", ") || "(none)"
      }.`,
    );
  }

  // The app gate, before the import, as on the wire: importing runs the
  // module's top-level code, and an app an admin switched off, or one whose
  // own migrations are behind this build, must not get that far. The wire
  // answers the second with a 503, and `UNAVAILABLE` is the code that becomes
  // one. `resolveAuthTier` below checks activation again.
  const gate = await checkAppGate(appSlug);
  if (!gate.open) {
    throw gate.reason === "updating"
      ? AppError.unavailable(APP_UPDATING_MESSAGE)
      : new AppError("NOT_FOUND", `"${appSlug}" is not active.`);
  }

  // Through the generated loader map, as the gateway loads it, so a route added
  // under `next dev` loads once `npm run registry` has run. A missing loader
  // and a module that throws at load are both NOT_FOUND to the page; the log
  // says which (./route-loader.ts).
  const modulePath = routeModulePath(pattern);
  const load = await loadRouteModule(appSlug, modulePath);
  if (load.kind === "missing") {
    console.warn(
      `[call] ${appSlug}/api/${modulePath} is declared but not in the generated route map. ` +
        `Run \`npm run registry\`.`,
    );
    throw new AppError("NOT_FOUND", `"${spec}" could not be loaded.`);
  }
  if (load.kind === "failed") {
    console.error(`[call] ${appSlug}/api/${modulePath} failed to load:`, load.error);
    throw new AppError("NOT_FOUND", `"${spec}" could not be loaded.`);
  }
  const mod = load.module;

  const declaration = mod[method];
  if (!isRouteDefinition(declaration)) {
    throw new AppError(
      "HANDLER_ERROR",
      `"${appSlug}" ${spec} is not a defineRoute() result.`,
    );
  }
  const def = declaration as RouteDefinition;

  // The page's own caller decides the tier, exactly as the HTTP mount would.
  // `authenticated` because a server component renders inside a page request:
  // the unlock cookies are path-scoped to /p/ and would not be readable from an
  // /apps/ page anyway.
  const resolution = await resolveAuthTier({
    appSlug,
    accepted: def.auth,
    mount: "authenticated",
  });

  switch (resolution.kind) {
    case "not-served":
      throw new AppError("NOT_FOUND", `"${spec}" is not reachable from a page.`);
    case "unauthenticated":
    case "password-required":
      throw AppError.unauthenticated();
    case "forbidden":
      throw AppError.forbidden("You do not have access to this app.");
  }

  let context: ResolvedContext;
  if (resolution.tier === "session" || resolution.tier === "signed-in") {
    const base = await buildAppContext(appSlug, resolution.dbUser);
    context =
      resolution.tier === "signed-in"
        ? {
            ...base,
            // A `signed-in` caller was never granted the app, so it carries no
            // app roles — mirroring the gateway, where handing over the app's
            // defaultRole would make every role gate default-allow.
            // Frozen like the user it copies (./context.ts).
            user: deepFreeze({ ...base.user, roles: [], hasRole: () => false }),
            auth: resolution.tier,
          }
        : { ...base, auth: resolution.tier };
  } else {
    context = { ...(await buildPublicAppContext(appSlug)), auth: resolution.tier };
  }

  // A synthetic Request so the pipeline has the shape it expects. Nothing reads
  // its body — `inputOverride` supplies the input, already an object.
  const request = new Request(
    `${getAppOrigin()}/api/apps/${appSlug}/${modulePath}`,
    { method },
  );

  return runRouteData<TOut>(def, request, {
    context,
    appSlug,
    routePattern: pattern,
    method,
    inputOverride: input ?? {},
  });
}
