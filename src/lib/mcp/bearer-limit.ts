/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-IP limit on failed MCP bearer-token checks.
 *
 * WHAT IT COUNTS. Failures only: a token that resolves to nothing, whether
 * unknown, expired or revoked. A valid token is never charged here and keeps
 * the per-client limit in src/app/api/mcp/route.ts. Charging every request to
 * its IP would let one caller behind a shared egress address, claude.ai's for
 * one, starve another, which is why that limit is per token.
 *
 * WHEN IT IS CONSULTED. Before the lookup. Once an address has spent its
 * budget, its next request is refused without the token being looked up. That
 * includes a valid token sent from the same address, since only the lookup
 * could tell it apart. The budget is sized so that honest clients don't spend
 * it.
 *
 * It checks, then charges, as the app-unlock lockout does
 * (src/lib/apps/unlock-rate-limit.ts). Requests already in flight when the
 * budget runs out are still looked up; the sustained rate is bounded.
 *
 * THE KEY is the client IP by the rule every limiter shares (`getClientIp`):
 * the last `x-forwarded-for` hop, then `x-real-ip`.
 */

import { getClientIp } from "@/lib/apps/public-access";
import { createRateLimiter, type RateLimiter, type RateLimiterOptions } from "@/lib/rate-limit";
import { resolveAccessToken, type TokenPrincipal } from "./store";

/**
 * 30 failures in a burst, then one more every 2 seconds. It is the budget of
 * the token endpoint, where a client whose token failed goes next to refresh
 * it. An access token lives an hour, so an honest client fails about once an
 * hour; a model's parallel tool calls can fail together, and a burst of 30
 * covers several of those at once.
 */
export const BEARER_FAILURE_LIMIT: RateLimiterOptions = {
  scope: "ip",
  name: "mcp-bearer-failures",
  maxTokens: 30,
  refillRatePerSecond: 0.5,
};

export type BearerCheck =
  | { status: "valid"; principal: TokenPrincipal }
  | { status: "invalid" }
  | { status: "limited"; retryAfterMs: number };

/**
 * A bearer check over `lookup`, limited by `limiter`. Both are swappable so a
 * test can count the lookups and stand in for a second server instance.
 */
export function createBearerCheck(
  lookup: (token: string) => Promise<TokenPrincipal | null> = resolveAccessToken,
  limiter: RateLimiter = createRateLimiter(BEARER_FAILURE_LIMIT),
) {
  return async function checkBearer(
    token: string,
    request: Request,
  ): Promise<BearerCheck> {
    const ip = getClientIp(request);

    const budget = await limiter.check(ip);
    if (!budget.allowed) return { status: "limited", retryAfterMs: budget.retryAfterMs };

    const principal = await lookup(token);
    if (principal) return { status: "valid", principal };

    // The charge's own answer isn't needed: this request was looked up and is
    // answered as invalid, and the next one's check sees the charge.
    await limiter.consume(ip);
    return { status: "invalid" };
  };
}

/** The MCP route's bearer check. */
export const checkBearer = createBearerCheck();
