import { NextResponse } from "next/server";
import { getReadOnlySession } from "@/lib/auth/session";
import { sql } from "@/lib/db/client";
import { appRegistry } from "@/generated/app-registry";

export const dynamic = "force-dynamic";

/** Cap the serialized properties bag so a client can't stuff large payloads. */
const MAX_PROPERTIES_BYTES = 4096;

/**
 * Records a client-side app telemetry event for the logged-in user. Fired by
 * the apps SDK `track()` helper from a widget or page (see lib/apps/sdk).
 *
 * Best-effort and tightly validated: the app slug must exist in the compile-time
 * registry, and the event name must be one the app actually declared in its
 * manifest `telemetry` list — so the table can't be stuffed with arbitrary
 * source/event keys from the browser. Server-side events go through
 * `context.telemetry` instead (see lib/apps/telemetry).
 */
export async function POST(request: Request) {
  const session = await getReadOnlySession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    appSlug?: unknown;
    event?: unknown;
    properties?: unknown;
  } | null;

  const appSlug = typeof body?.appSlug === "string" ? body.appSlug : "";
  const event = typeof body?.event === "string" ? body.event : "";

  const app = appRegistry.find((a) => a.slug === appSlug);
  if (!app) {
    return NextResponse.json({ error: "Invalid appSlug" }, { status: 400 });
  }
  // Only events the app declared in its manifest are accepted.
  if (!app.telemetry.some((t) => t.name === event)) {
    return NextResponse.json({ error: "Undeclared event" }, { status: 400 });
  }

  // Accept only a plain-object properties bag, and bound its size.
  let properties: Record<string, unknown> = {};
  const raw = body?.properties;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const serialized = JSON.stringify(raw);
    if (serialized.length <= MAX_PROPERTIES_BYTES) {
      properties = raw as Record<string, unknown>;
    }
  }

  try {
    await sql`
      insert into public.telemetry_events
        (source_type, source_slug, event_name, user_id, properties)
      values ('app', ${appSlug}, ${event}, ${session.user.id}, ${sql.json(
        properties as Parameters<typeof sql.json>[0],
      )})
    `;
  } catch {
    // Telemetry is non-critical — swallow write failures.
    return NextResponse.json({ error: "Failed to record" }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
