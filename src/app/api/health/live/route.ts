import { NextResponse } from "next/server";

// Liveness probe: is the Node process up? Does not hit the DB — we want
// transient DB blips to take the pod out of the Service (via readiness)
// without restarting it (via liveness). Always 200 unless the process
// itself is stuck.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
