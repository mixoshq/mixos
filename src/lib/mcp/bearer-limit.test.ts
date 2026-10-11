/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "@/lib/rate-limit";
import { BEARER_FAILURE_LIMIT, createBearerCheck } from "./bearer-limit";
import type { TokenPrincipal } from "./store";

// ── fixtures ────────────────────────────────────────────────────────────────

// No database: the limiter's Postgres read and charge throw, so it falls back
// to its in-memory bucket, which holds the same budget (src/lib/rate-limit.ts).
// rate-limit.integration.test.ts runs the same limit against a real Postgres.
(globalThis as { __pg?: unknown }).__pg = () => {
  throw new Error("no database in this test");
};
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (String(args[0]).startsWith("[rate-limit] postgres unavailable")) return;
  warn(...args);
};

const VALID = "ros_at_valid";
const PRINCIPAL: TokenPrincipal = {
  userId: "8f6c1d0e-0000-4000-8000-000000000001",
  clientId: "ros_client_test",
  clientName: "Test client",
  grantedApps: [],
};

/** A bearer check over a fresh budget, with a lookup that records each call. */
function recordingCheck() {
  const lookups: string[] = [];
  const checkBearer = createBearerCheck(async (token) => {
    lookups.push(token);
    return token === VALID ? PRINCIPAL : null;
  }, createRateLimiter(BEARER_FAILURE_LIMIT));
  return { lookups, checkBearer };
}

function from(ip: string): Request {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

const BUDGET = BEARER_FAILURE_LIMIT.maxTokens;

// ── the limit ───────────────────────────────────────────────────────────────

test("failed checks past the budget are refused before the token is looked up", async () => {
  const { lookups, checkBearer } = recordingCheck();
  const ip = "192.0.2.10";

  for (let i = 1; i <= BUDGET; i++) {
    assert.deepEqual(await checkBearer(`ros_at_guess_${i}`, from(ip)), { status: "invalid" });
  }
  assert.equal(lookups.length, BUDGET);

  const refused = await checkBearer("ros_at_guess_next", from(ip));
  assert.equal(refused.status, "limited");
  assert.ok(refused.status === "limited" && refused.retryAfterMs > 0, "a Retry-After to give");
  assert.equal(lookups.length, BUDGET, "a refused check looks nothing up");

  // Only the lookup could tell a valid token apart, so it waits too.
  assert.equal((await checkBearer(VALID, from(ip))).status, "limited");
  assert.equal(lookups.length, BUDGET);

  // Another address has its own budget.
  assert.deepEqual(await checkBearer(VALID, from("192.0.2.11")), {
    status: "valid",
    principal: PRINCIPAL,
  });
});

test("a valid token is never charged", async () => {
  const { lookups, checkBearer } = recordingCheck();
  const ip = "192.0.2.20";

  for (let i = 1; i <= BUDGET * 4; i++) {
    assert.equal((await checkBearer(VALID, from(ip))).status, "valid");
  }
  // The whole budget of failures is still there.
  for (let i = 1; i <= BUDGET; i++) {
    assert.equal((await checkBearer(`ros_at_guess_${i}`, from(ip))).status, "invalid");
  }
  assert.equal((await checkBearer("ros_at_guess_next", from(ip))).status, "limited");
  assert.equal(lookups.length, BUDGET * 5);
});

test("a check is charged to the last x-forwarded-for hop", async () => {
  const { checkBearer } = recordingCheck();
  // The earlier hops are whatever the client sent, so varying them buys
  // nothing: every request below is charged to 203.0.113.9.
  for (let i = 1; i <= BUDGET; i++) {
    const spoofed = new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: { "x-forwarded-for": `198.51.100.${i}, 203.0.113.9` },
    });
    assert.equal((await checkBearer(`ros_at_guess_${i}`, spoofed)).status, "invalid");
  }
  assert.equal((await checkBearer("ros_at_guess_next", from("203.0.113.9"))).status, "limited");
});
