/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The public app API surface: `/api/p/<slug>/<path>`.
 *
 * The cookie-less view of the same pipeline the authenticated mount uses —
 * `dispatchAppRoute` with `mount: "public"`, which narrows the eligible tiers to
 * `password`, `key` and `public`. A route declaring only identity tiers is a 404
 * here, never a 401, so probing this surface cannot tell "exists but forbidden"
 * from "no such route".
 *
 * `key` is served here and nowhere else: this is the mount for a caller with no
 * session cookie, such as a machine-to-machine integration, and `/api/apps` is
 * the one the browser SDK calls with its cookie.
 *
 * Neither mount is behind the proxy (src/proxy.ts, `config.matcher`), so nothing
 * upstream checks for a cookie or bounces the caller to /login, and "no session
 * cookie" is the expected state here. Everything that gates access to a route
 * happens inside the dispatcher.
 */
import { appRouteOptions, dispatchAppRoute, type HttpMethod } from "@/lib/apps/dispatch";

interface RouteContext {
  params: Promise<{ appSlug: string; slug?: string[] }>;
}

async function handle(
  request: Request,
  { params }: RouteContext,
  method: HttpMethod,
): Promise<Response> {
  const { appSlug, slug = [] } = await params;
  return dispatchAppRoute({
    request,
    method,
    appSlug,
    segments: slug,
    mount: "public",
  });
}

export const GET = (req: Request, ctx: RouteContext) => handle(req, ctx, "GET");
export const POST = (req: Request, ctx: RouteContext) =>
  handle(req, ctx, "POST");
export const PUT = (req: Request, ctx: RouteContext) => handle(req, ctx, "PUT");
export const PATCH = (req: Request, ctx: RouteContext) =>
  handle(req, ctx, "PATCH");
export const DELETE = (req: Request, ctx: RouteContext) =>
  handle(req, ctx, "DELETE");
export const OPTIONS = (req: Request) => appRouteOptions(req);
