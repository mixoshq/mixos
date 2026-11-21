/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getReadOnlySession } from "@/lib/auth/session";
import { createRateLimiter } from "@/lib/rate-limit";
import { globalSearch, searchMore, SearchUnavailableError } from "@/lib/search/server";
import { MAX_OFFSET, MAX_QUERY, MORE_PAGE } from "@/lib/search/types";

export const dynamic = "force-dynamic";

/**
 * Per person. The modal waits for a pause in typing before it asks, so a
 * person searching normally asks a few times a second at most; this is there
 * for a client that doesn't.
 */
const searchLimiter = createRateLimiter({
  scope: "route",
  name: "search",
  maxTokens: 60,
  refillRatePerSecond: 2,
});

const ParamsSchema = z.object({
  q: z.string().trim().min(1).max(MAX_QUERY),
  source: z.string().min(1).max(200).optional(),
  object: z.string().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
});

/**
 * MixOS's global search: the ⌘K modal's one endpoint.
 *
 *   GET /api/search?q=notes
 *     Every source's first page, grouped by app, in the person's order.
 *   GET /api/search?q=notes&source=<slug>&object=<name>&offset=5
 *     The next page of one app's object: Show 10 more.
 *
 * Session only (the proxy already turns away a request without one, and this
 * checks the session is real). The apps searched are the ones the person
 * installed and holds; each app's handler runs read-only, as them. See
 * src/lib/search/server.ts and docs/apps/search.md.
 */
export async function GET(request: Request) {
  const session = await getReadOnlySession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = await searchLimiter.consume(session.user.id);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many searches. Try again in a moment." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  const url = new URL(request.url);
  const parsed = ParamsSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid search." }, { status: 400 });
  }
  const { q, source, object, offset } = parsed.data;
  const more = source !== undefined || object !== undefined || offset !== undefined;
  if (more && (source === undefined || object === undefined || offset === undefined)) {
    return NextResponse.json(
      { error: "Show more needs source, object and offset together." },
      { status: 400 },
    );
  }

  try {
    const body = more
      ? await searchMore(session.user.id, q, source!, object!, offset!, MORE_PAGE)
      : await globalSearch(session.user.id, q);
    return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof SearchUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error("[search] the search failed:", err);
    return NextResponse.json({ error: "Search failed. Try again." }, { status: 500 });
  }
}
