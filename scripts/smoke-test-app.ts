/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Smoke-test apps' API routes on a running MixOS, as a signed-in user.
 *
 *   SMOKE_EMAIL=you@example.com SMOKE_PASSWORD='…' \
 *     npx tsx scripts/smoke-test-app.ts [<slug> …] [--base-url <url>] [--skip-unavailable]
 *
 * With no slug it tests every app in this build. `--base-url` defaults to
 * http://localhost:3000 (or $PORT). Run it from the checkout the server was
 * built from: the routes come from src/generated/app-registry.ts, which
 * `npm run dev`, `npm run build` and `npm run registry` write.
 *
 * `--skip-unavailable` lists a route that answers 503 UNAVAILABLE as skipped
 * rather than failed: it needs a connector's credentials, or something else
 * this server hasn't configured. The pull-request check
 * (.github/workflows/extensions.yml) uses it, because CI has no credentials. In
 * a checkout, configure what the route needs instead, and test it for real.
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
  exitCodeFor,
  formatApp,
  formatSummary,
  normalizeBaseUrl,
  runSmoke,
  setupFailure,
  signInFromEnv,
  type SmokeApp,
  type Verdict,
} from "./app-smoke";

const REGISTRY = path.resolve(__dirname, "../src/generated/app-registry.ts");

const USAGE = [
  "Usage: npx tsx scripts/smoke-test-app.ts [<slug> ...] [--base-url <url>] [--skip-unavailable]",
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

interface Args {
  slugs: string[];
  baseUrl: string;
  skipUnavailable: boolean;
  help: boolean;
}

function parseArgs(argv: string[], fallbackBaseUrl: string): Args {
  const slugs: string[] = [];
  let baseUrl = fallbackBaseUrl;
  let skipUnavailable = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--skip-unavailable") skipUnavailable = true;
    else if (arg === "--base-url") {
      const value = argv[++i];
      if (!value) throw new SmokeSetupError("--base-url needs a URL (see --help)");
      baseUrl = normalizeBaseUrl(value);
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = normalizeBaseUrl(arg.slice("--base-url=".length));
    } else if (arg.startsWith("-")) {
      throw new SmokeSetupError(`unknown option ${arg} (see --help)`);
    } else if (!slugs.includes(arg)) {
      slugs.push(arg);
    }
  }
  return { slugs, baseUrl, skipUnavailable, help };
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

/** The session to test with, and whose it is. Its values are kept out of the output. */
function signedIn(baseUrl: string): Promise<{ cookie: string; user: string }> {
  return signInFromEnv({
    baseUrl,
    onCookie: (cookie) => {
      for (const pair of cookie.split(";")) keepSecret(pair.slice(pair.indexOf("=") + 1).trim());
    },
  });
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
      skipUnavailable: args.skipUnavailable,
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
