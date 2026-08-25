/**
 * The authenticated app API surface: `/api/apps/<slug>/<path>`.
 *
 * Everything happens in `dispatchAppRoute` — this file exists to bind that
 * pipeline to a mount and to Next's five method exports. The two mounts were
 * parallel implementations until Phase 1; keeping them as thin bindings is what
 * stops them drifting apart again.
 *
 * This mount serves the identity tiers (`session`, `signed-in`) plus `public`,
 * because a widget calling its own app always arrives here via
 * `createAppClient`, including when the route it wants is deliberately public.
 * `password` is not served here: the unlock cookies are path-scoped to `/p/` and
 * `/api/p/`, so a browser would never send one to this path.
 */
import { dispatchAppRoute, type HttpMethod } from "@/lib/apps/dispatch";

interface RouteContext {
  params: Promise<{ slug: string[] }>;
}

async function handle(
  request: Request,
  { params }: RouteContext,
  method: HttpMethod,
): Promise<Response> {
  const [appSlug, ...segments] = (await params).slug;
  return dispatchAppRoute({
    request,
    method,
    appSlug: appSlug ?? "",
    segments,
    mount: "authenticated",
  });
}

export const GET = (req: Request, ctx: RouteContext) => handle(req, ctx, "GET");
export const POST = (req: Request, ctx: RouteContext) => handle(req, ctx, "POST");
export const PUT = (req: Request, ctx: RouteContext) => handle(req, ctx, "PUT");
export const PATCH = (req: Request, ctx: RouteContext) => handle(req, ctx, "PATCH");
export const DELETE = (req: Request, ctx: RouteContext) => handle(req, ctx, "DELETE");
