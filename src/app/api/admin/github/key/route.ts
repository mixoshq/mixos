/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/apps/access";
import { verifyCsrf } from "@/lib/apps/csrf";
import { requireReadOnlySession } from "@/lib/auth/session";
import { getAppOrigin } from "@/lib/env/origin";
import { replacePrivateKey } from "@/lib/github/link";
import type { GitHubOutcome } from "@/lib/github/outcomes";

/**
 * Admin > GitHub's Replace private key: the pasted key arrives here, in the
 * body of a same-origin POST, and the work is replacePrivateKey()
 * (src/lib/github/link.ts).
 *
 * A route rather than a server action because of what reaches a log: `next
 * dev` prints every server action's arguments to the terminal, and this one's
 * argument is a private key. A request body is never printed.
 *
 * An admin first, then the origin and the CSRF token (src/lib/apps/csrf.ts),
 * then the body. Answers with the outcome as JSON, never with the key.
 */
export const dynamic = "force-dynamic";

/** A PEM GitHub generates is under 2 KB; anything near this isn't one. */
const MAX_BODY_CHARS = 32 * 1024;

const answer = (outcome: GitHubOutcome, status = 200) =>
  NextResponse.json(outcome, { status, headers: { "cache-control": "no-store" } });

const refusal = (code: string, message: string): GitHubOutcome => ({ ok: false, code, message, tone: "warning" });

/** Whether the request came from a page on this host, as Next checks for server actions. */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const expected = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return expected !== null && host === expected;
}

export async function POST(request: NextRequest) {
  const session = await requireReadOnlySession();
  let actor: { id: string; email: string };
  try {
    const user = await requireAdmin(session);
    actor = { id: user.id, email: user.email };
  } catch {
    return answer(refusal("forbidden", "Admin access required."), 403);
  }
  if (!sameOrigin(request) || !verifyCsrf(request)) {
    return answer(refusal("csrf", "That didn't come from this page. Reload it and try again."), 403);
  }

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return answer(refusal("input", "That is too long to be a private key from GitHub."), 413);
  }
  let pem: unknown;
  try {
    pem = (JSON.parse(text) as { pem?: unknown })?.pem;
  } catch {
    pem = undefined;
  }
  if (typeof pem !== "string") return answer(refusal("input", "Paste the private key, the whole .pem file."), 400);

  const outcome = await replacePrivateKey({ pem }, { admin: async () => actor, origin: getAppOrigin });
  if (outcome.ok) revalidatePath("/admin/github");
  return answer(outcome);
}
