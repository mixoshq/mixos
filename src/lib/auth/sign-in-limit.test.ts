/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth, raw, skipCSRFCheck } from "@auth/core";
import { AuthError } from "next-auth";
import {
  buildAuthOptions,
  createCredentialsAuthorize,
  type CredentialsAccount,
} from "./config";
import {
  isSignInRateLimited,
  SIGN_IN_RATE_LIMITED,
  signInLimitKey,
  SignInRateLimited,
} from "./sign-in-limit";

// ── fixtures ────────────────────────────────────────────────────────────────

// The pool is a lazy proxy that reads `globalThis.__pg` (src/lib/db/client.ts).
// Here it has no database behind it. The limiter's Postgres charge throws, so
// the limiter falls back to its in-memory bucket (src/lib/rate-limit.ts), which
// holds the same budget: bursts below meet the real numbers. The query
// builder's statements find no account.
(globalThis as { __pg?: unknown }).__pg = Object.assign(
  () => {
    throw new Error("no database in this test");
  },
  { unsafe: async () => [] },
);

// That fallback warns on every charge; only that warning is dropped. Auth.js
// logs every failed sign-in, so the configs below give it a quiet logger.
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (String(args[0]).startsWith("[rate-limit] postgres unavailable")) return;
  warn(...args);
};
const quiet = { error() {} };

const ORIGIN = "http://localhost:3000";
const PASSWORD = "the right password";
const ACCOUNT: CredentialsAccount = {
  id: "8f6c1d0e-0000-4000-8000-000000000001",
  email: "ada@example.test",
  display_name: "Ada",
  password_hash: "hash:the right password",
};

/** A password check over one account that records each lookup and each hash run. */
function recordingCheck() {
  const lookups: string[] = [];
  const hashes: string[] = [];
  return {
    lookups,
    hashes,
    check: {
      async findAccount(email: string) {
        lookups.push(email);
        return email === ACCOUNT.email ? ACCOUNT : null;
      },
      async verifyPassword(plaintext: string, hash: string) {
        hashes.push(hash);
        return hash === `hash:${plaintext}`;
      },
    },
  };
}

function requestFrom(ip: string): Request {
  return new Request(`${ORIGIN}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

/** The production config, as next-auth completes it before calling Auth.js. */
async function productionConfig() {
  return {
    ...(await buildAuthOptions()),
    secret: "a test secret, long enough for the session cookie",
    basePath: "/api/auth",
    logger: quiet,
  };
}

/**
 * Auth.js's own route, as any client can call it: a CSRF token from
 * /api/auth/csrf, then the form POST. next-auth's route handler is
 * `Auth(request, config)` (node_modules/next-auth/index.js).
 */
async function viaCallbackRoute(ip: string, email: string, password: string) {
  const config = await productionConfig();
  const csrf = await Auth(
    new Request(`${ORIGIN}/api/auth/csrf`, { headers: { "x-forwarded-for": ip } }),
    config,
  );
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const cookie = csrf.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const res = await Auth(
    new Request(`${ORIGIN}/api/auth/callback/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        "x-forwarded-for": ip,
      },
      body: new URLSearchParams({ email, password, csrfToken, callbackUrl: `${ORIGIN}/` }),
    }),
    config,
  );
  const location = new URL(res.headers.get("location") ?? "", ORIGIN);
  return { status: res.status, code: location.searchParams.get("code") };
}

/**
 * The login page's server action. It calls next-auth's `signIn()`, which
 * copies the action request's headers into a Request for the callback and
 * runs Auth.js raw, with its CSRF check off because Next checks a server
 * action's origin instead (node_modules/next-auth/lib/actions.js). A failed
 * sign-in comes back as the thrown error the action catches.
 */
async function viaServerAction(ip: string, email: string, password: string) {
  const config = await productionConfig();
  const actionHeaders = new Headers({ "x-forwarded-for": ip });
  actionHeaders.set("content-type", "application/x-www-form-urlencoded");
  try {
    await Auth(
      new Request(`${ORIGIN}/api/auth/callback/credentials?`, {
        method: "POST",
        headers: actionHeaders,
        body: new URLSearchParams({ email, password, callbackUrl: "/" }),
      }),
      { ...config, raw, skipCSRFCheck },
    );
    return { error: null };
  } catch (err) {
    return { error: err };
  }
}

// ── the key ─────────────────────────────────────────────────────────────────

test("an attempt is charged to the last x-forwarded-for hop, then x-real-ip", () => {
  const key = (headers: Record<string, string>) =>
    signInLimitKey(new Request(ORIGIN, { headers }));

  // The last hop is the one the platform's own proxy appended; earlier ones
  // are whatever the client sent.
  assert.equal(key({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" }), "203.0.113.9");
  assert.equal(key({ "x-forwarded-for": " 203.0.113.9 , " }), "203.0.113.9");
  assert.equal(key({ "x-forwarded-for": "2001:db8::1" }), "2001:db8::1");
  assert.equal(
    key({ "x-forwarded-for": "198.51.100.7", "x-real-ip": "203.0.113.5" }),
    "198.51.100.7",
  );
  assert.equal(key({ "x-real-ip": "203.0.113.5" }), "203.0.113.5");
  assert.equal(key({ "x-forwarded-for": " , ", "x-real-ip": "203.0.113.5" }), "203.0.113.5");
  assert.equal(key({}), "unknown");
  assert.equal(signInLimitKey(undefined), "unknown");
});

// ── the password check ──────────────────────────────────────────────────────

test("the 11th attempt in a burst is refused before the account is read or a hash run", async () => {
  const { lookups, hashes, check } = recordingCheck();
  const authorize = createCredentialsAuthorize(check);
  const from = requestFrom("192.0.2.11");

  for (let i = 1; i <= 10; i++) {
    assert.equal(await authorize({ email: ACCOUNT.email, password: "wrong" }, from), null);
  }
  assert.equal(lookups.length, 10);
  assert.equal(hashes.length, 10);

  // Refused even with the right password, and nothing is looked at.
  await assert.rejects(
    authorize({ email: ACCOUNT.email, password: PASSWORD }, from),
    (err: unknown) => err instanceof SignInRateLimited && isSignInRateLimited(err),
  );
  assert.equal(lookups.length, 10, "a refused attempt reads no account");
  assert.equal(hashes.length, 10, "a refused attempt runs no hash");

  // Another client's budget is its own.
  const other = await authorize({ email: ACCOUNT.email, password: PASSWORD }, requestFrom("192.0.2.12"));
  assert.equal(other?.id, ACCOUNT.id);
});

test("a refused attempt is the same for a known and an unknown email", async () => {
  const { lookups, hashes, check } = recordingCheck();
  const authorize = createCredentialsAuthorize(check);
  const from = requestFrom("192.0.2.21");
  for (let i = 1; i <= 10; i++) await authorize({ email: "x@example.test", password: "x" }, from);
  lookups.length = 0;
  hashes.length = 0;

  const refusal = async (email: string) => {
    const err = await authorize({ email, password: PASSWORD }, from).then(
      () => assert.fail("not refused"),
      (e: unknown) => e as SignInRateLimited,
    );
    return { type: err.type, code: err.code, message: err.message };
  };
  const known = await refusal(ACCOUNT.email);
  const unknown = await refusal("nobody@example.test");
  assert.deepEqual(known, unknown);
  assert.equal(known.code, SIGN_IN_RATE_LIMITED);
  assert.match(known.message, /^Sign-in limit reached/, "the server log can tell it apart");
  assert.deepEqual([lookups, hashes], [[], []]);
});

// ── both routes, one budget ─────────────────────────────────────────────────

test("Auth.js's callback route and the login action draw on one budget", async () => {
  // Route first: six attempts there, four through the action, then both refuse.
  const a = "192.0.2.31";
  for (let i = 1; i <= 6; i++) {
    assert.deepEqual(await viaCallbackRoute(a, "x@example.test", "wrong"), {
      status: 302,
      code: "credentials",
    });
  }
  for (let i = 1; i <= 4; i++) {
    const { error } = await viaServerAction(a, "x@example.test", "wrong");
    assert.ok(error instanceof AuthError && !isSignInRateLimited(error));
  }
  // Auth.js's route answers in its usual error form, with the limit's code.
  assert.deepEqual(await viaCallbackRoute(a, "x@example.test", "wrong"), {
    status: 302,
    code: SIGN_IN_RATE_LIMITED,
  });
  assert.ok(isSignInRateLimited((await viaServerAction(a, "x@example.test", "wrong")).error));

  // The other way round: the action spends the budget, the route is refused.
  const b = "192.0.2.32";
  for (let i = 1; i <= 10; i++) await viaServerAction(b, "x@example.test", "wrong");
  assert.equal((await viaCallbackRoute(b, "x@example.test", "wrong")).code, SIGN_IN_RATE_LIMITED);

  // A client that spent nothing is still answered as a wrong password.
  assert.equal((await viaCallbackRoute("192.0.2.33", "x@example.test", "wrong")).code, "credentials");
});

test("on the server-action path a refused attempt is told apart from a wrong password", async () => {
  const ip = "192.0.2.41";
  const wrong = (await viaServerAction(ip, "x@example.test", "wrong")).error;
  assert.ok(wrong instanceof AuthError, "a wrong password is an AuthError");
  assert.equal(isSignInRateLimited(wrong), false);

  for (let i = 2; i <= 10; i++) await viaServerAction(ip, "x@example.test", "wrong");
  const refused = (await viaServerAction(ip, "x@example.test", "wrong")).error;
  assert.ok(refused instanceof AuthError, "still an AuthError, so nothing else changes");
  assert.equal(isSignInRateLimited(refused), true);

  assert.equal(isSignInRateLimited(new Error("boom")), false);
  assert.equal(isSignInRateLimited(undefined), false);
});
