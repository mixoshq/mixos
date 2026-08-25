import { NextResponse } from "next/server";
import { getReadOnlySession } from "@/lib/auth/session";
import { deleteSubscriptionByEndpoint } from "@/lib/push/subscriptions";

export const dynamic = "force-dynamic";

/** Remove a subscription by endpoint (e.g. on logout or when the user opts out). */
export async function POST(request: Request) {
  const session = await getReadOnlySession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { endpoint?: string }
    | null;
  if (!body?.endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
  }

  await deleteSubscriptionByEndpoint(body.endpoint);
  return NextResponse.json({ ok: true });
}
