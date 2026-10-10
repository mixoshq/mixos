/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Smoke-test apps' API routes on a running MixOS, as a signed-in user.
 *
 *   SMOKE_EMAIL=you@example.com SMOKE_PASSWORD='…' \
 *     npx tsx scripts/smoke-test-app.ts [<slug> …] [--base-url <url>]
 *
 * With no slug it tests every app in this build. `--base-url` defaults to
 * http://localhost:3000 (or $PORT). Run it from the checkout the server was
 * built from: the routes come from src/generated/app-registry.ts, which
 * `npm run dev`, `npm run build` and `npm run registry` write.
 *
 * SIGNING IN. Either of:
 *
 *   SMOKE_EMAIL, SMOKE_PASSWORD   signs in with the password, like the user
 *   SMOKE_COOKIE                  an existing session: the value of the
 *                                 `authjs.session-token` cookie
 *                                 (`__Secure-authjs.session-token` over HTTPS),
 *                                 or a whole `name=value` Cookie header
 *
 * SMOKE_COOKIE wins when both are set. Neither the password nor the cookie is
 * ever printed.
 *
 * Test like a real user: activate each app and grant it to that user first. An
 * app that is inactive, or not granted, is reported as such and fails the run.
 * This script never changes either.
 *
 * WHAT IT SENDS, and how it reads each answer: scripts/app-smoke.ts. In short,
 * GET and HEAD only, with a fake value in every path param. POST, PUT, PATCH
 * and DELETE routes are listed and never sent.
 *
 * OUTPUT. A table per app on stderr, then one JSON line on stdout: the verdict,
 * with every app and every route (`Verdict` in scripts/app-smoke.ts).
 *
 * EXIT CODE.
 *   0  nothing failed and nothing was blocked
 *   1  a route failed (5xx, network error, timeout) or was blocked (signed
 *      out, app inactive or not granted, rate limited)
 *   2  the run couldn't start: bad arguments, no registry, no sign-in, or no
 *      server at the base URL
 */

import fs from "fs";
import path from "path";
import {
  SmokeSetupError,
  buildVerdict,
  cookieHeaderFrom,
  exitCodeFor,
  formatApp,
  formatSummary,
  runSmoke,
  sessionUser,
  setupFailure,
  signIn,
  type SmokeApp,
  type Verdict,
} from "./app-smoke";

const REGISTRY = path.resolve(__dirname, "../src/generated/app-registry.ts");

const USAGE = [
  "Usage: npx tsx scripts/smoke-test-app.ts [<slug> ...] [--base-url <url>]",
  "Sign in with SMOKE_EMAIL and SMOKE_PASSWORD, or pass a session as SMOKE_COOKIE.",
].join("\n");

/** Values that must never reach the output. Short ones are left alone: they'd mangle it. */
const secrets: string[] = [];

function keepSecret(value: string | undefined): void {
  if (!value || value.length < 6) return;
  // As written, and as it would appear inside the JSON line.
  secrets.push(value, JSON.stringify(value).slice(1, -1));
}

function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

function say(line: string): void {
  console.error(redact(line));
}

function baseUrlFrom(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SmokeSetupError(`--base-url ${raw} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SmokeSetupError(`--base-url must be http or https, not ${url.protocol}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

interface Args {
  slugs: string[];
  baseUrl: string;
  help: boolean;
}

function parseArgs(argv: string[], fallbackBaseUrl: string): Args {
  const slugs: string[] = [];
  let baseUrl = fallbackBaseUrl;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--base-url") {
      const value = argv[++i];
      if (!value) throw new SmokeSetupError("--base-url needs a URL (see --help)");
      baseUrl = baseUrlFrom(value);
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = baseUrlFrom(arg.slice("--base-url=".length));
    } else if (arg.startsWith("-")) {
      throw new SmokeSetupError(`unknown option ${arg} (see --help)`);
    } else if (!slugs.includes(arg)) {
      slugs.push(arg);
    }
  }
  return { slugs, baseUrl, help };
}

async function loadApps(slugs: string[]): Promise<SmokeApp[]> {
  if (!fs.existsSync(REGISTRY)) {
    throw new SmokeSetupError(
      "src/generated/app-registry.ts is missing. Run `npm run registry` first.",
    );
  }
  const { appRegistry } = (await import("../src/generated/app-registry")) as {
    appRegistry: SmokeApp[];
  };
  if (slugs.length === 0) return appRegistry;

  const unknown = slugs.filter((s) => !appRegistry.some((a) => a.slug === s));
  if (unknown.length > 0) {
    const known = appRegistry.map((a) => a.slug).join(", ") || "none";
    throw new SmokeSetupError(
      `not in this build's registry: ${unknown.join(", ")}. Apps in it: ${known}. ` +
        "Template folders (starting with _) never are; run `npm run registry` after adding an app.",
    );
  }
  return slugs.map((s) => appRegistry.find((a) => a.slug === s)!);
}

/** The session to test with, and whose it is. */
async function signedIn(baseUrl: string): Promise<{ cookie: string; user: string }> {
  const { SMOKE_COOKIE, SMOKE_EMAIL, SMOKE_PASSWORD } = process.env;
  let cookie: string;
  if (SMOKE_COOKIE) {
    // A line break would make fetch throw an error that quotes the value.
    if (/[\r\n\0]/.test(SMOKE_COOKIE)) {
      throw new SmokeSetupError("SMOKE_COOKIE holds a line break or a NUL. Copy the value again.");
    }
    cookie = cookieHeaderFrom(SMOKE_COOKIE, baseUrl);
  } else if (SMOKE_EMAIL && SMOKE_PASSWORD) {
    cookie = await signIn({ baseUrl, email: SMOKE_EMAIL, password: SMOKE_PASSWORD });
  } else {
    throw new SmokeSetupError(
      "no sign-in. Set SMOKE_EMAIL and SMOKE_PASSWORD, or SMOKE_COOKIE, for a user the apps are granted to.",
    );
  }
  for (const pair of cookie.split(";")) keepSecret(pair.slice(pair.indexOf("=") + 1).trim());

  const user = await sessionUser({ baseUrl, cookie });
  if (!user) {
    throw new SmokeSetupError(
      SMOKE_COOKIE
        ? "SMOKE_COOKIE wasn't accepted: it may have expired, or come from another server."
        : "the server didn't accept the session it just issued.",
    );
  }
  return { cookie, user };
}

async function run(): Promise<Verdict> {
  const fallback = `http://localhost:${process.env.PORT || "3000"}`;
  let baseUrl = fallback;
  try {
    const args = parseArgs(process.argv.slice(2), fallback);
    baseUrl = args.baseUrl;
    if (args.help) {
      console.log(USAGE);
      process.exit(0);
    }
    const apps = await loadApps(args.slugs);
    const { cookie, user } = await signedIn(baseUrl);
    say(`[smoke] ${baseUrl}, signed in as ${user}`);

    const results = await runSmoke({
      baseUrl,
      cookie,
      apps,
      onApp: (app) => formatApp(app).forEach(say),
    });
    return buildVerdict(baseUrl, user, results);
  } catch (err) {
    if (err instanceof SmokeSetupError) return setupFailure(baseUrl, err.message);
    say(`[smoke] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return setupFailure(
      baseUrl,
      `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

keepSecret(process.env.SMOKE_PASSWORD);
keepSecret(process.env.SMOKE_COOKIE?.trim());

void run().then((verdict) => {
  say(formatSummary(verdict));
  // Exit once the line is written: stdout to a pipe can be asynchronous.
  process.stdout.write(`${redact(JSON.stringify(verdict))}\n`, () =>
    process.exit(exitCodeFor(verdict)),
  );
});
