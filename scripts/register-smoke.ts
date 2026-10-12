/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What `npm run register -- app/<slug> --smoke` adds around Register
// (scripts/register-cli.ts calls it): checks before it, so a refusal leaves
// nothing registered, and steps after it, once Register has released both
// locks. It reports, and never rolls back.
//
// BEFORE REGISTER, in this order. Each refusal changes nothing.
//
//   1. This checkout's database is on this machine: a Unix socket, loopback or
//      `host.docker.internal` (src/lib/db/locality.ts), the rule "Activate in
//      this checkout" follows. Other instances may use any other database, and
//      --smoke would apply the app's migrations there before anyone reviewed
//      them in a pull request, then turn the app on and grant it for all of
//      them. `--database-is-disposable` says that database is the caller's
//      alone, to throw away.
//   2. The server at the base URL signs in the smoke user, from SMOKE_COOKIE or
//      SMOKE_EMAIL and SMOKE_PASSWORD, as scripts/smoke-test-app.ts does.
//   3. That user is in this checkout's database, so the server and this command
//      use the same one.
//   4. An app that replaces a different extension under its slug (the release
//      step's identity check, scripts/sync-app-registry.ts) needs its slug
//      typed, `--confirm-replaces <slug>`, as Activate on Admin > Apps does:
//      activating it gives it the grants, settings and data of the extension
//      before it. The typed slug goes to setAppActive(), which checks it again.
//
// AFTER REGISTER:
//
//   1. scripts/migrate.ts, which is what `npm run migrate:apps` runs, without
//      the registry generator npm's `pre` hook would run first. Register has
//      just run the generator with PATH and TMPDIR only; running it again here
//      would load the app's code with this shell's database URL and keys.
//   2. scripts/smoke-activate.ts: Activate's checks and audit row, then a grant
//      to the smoke user with its audit row, as `cli:<os user>@<hostname>`. A
//      child process, so it reads the registry the generator just wrote.
//   3. scripts/smoke-test-app.ts for the app, with the session the sign-in
//      before Register made. It calls the app as that user would, through the
//      activation gate like any request: nothing here goes around it.

import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { sql } from "../src/lib/db/client";
import { thisDatabase, type DatabaseLocation } from "../src/lib/db/locality";
import { describeIdentity, extensionIdentity, type IdentityDetails } from "../src/lib/repository/identity";
import { readInstallRecord } from "../src/lib/repository/install-record";
import { pendingLocation } from "../src/lib/repository/pending";
import { describeHosts } from "../src/lib/repository/pending-outcomes";
import { sourceHost } from "../src/lib/repository/provenance";
import { SmokeSetupError, normalizeBaseUrl, signInFromEnv, type AppResult, type Verdict } from "./app-smoke";

/** What the command line asked of --smoke. */
export interface SmokeRequest {
  /** The server to test, as given to --base-url. */
  baseUrl?: string;
  databaseIsDisposable: boolean;
  /** The slug typed with --confirm-replaces. */
  confirmReplaces?: string;
}

/** The app's row in this checkout's database, as far as --smoke reads it. */
export interface AppRow {
  isActive: boolean;
  identity: string | null;
  identityChangedAt: Date | null;
  replacedIdentity: string | null;
}

/** A child process that finished, or didn't (code null). */
export interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** What scripts/smoke-activate.ts prints, as one JSON line. */
export type SmokeActivation =
  | { ok: true; activated: boolean; replaced: IdentityDetails; grant: "added" | "existing" | "global" }
  | { ok: false; code: string; message: string };

const SmokeActivationSchema = z.union([
  z.object({
    ok: z.literal(true),
    activated: z.boolean(),
    replaced: z.unknown().transform((v) => (v ?? null) as IdentityDetails),
    grant: z.enum(["added", "existing", "global"]),
  }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);

/** Everything --smoke does outside its own logic, so a test can stand in for each. */
export interface SmokeSteps {
  /** Where this checkout's database is: the pool Register's lock and audit use. */
  database(): DatabaseLocation;
  /** Sign in at the server; throws SmokeSetupError. */
  signIn(baseUrl: string): Promise<{ cookie: string; user: string }>;
  userExists(email: string): Promise<boolean>;
  appRow(slug: string): Promise<AppRow | null>;
  migrate(onLine: (line: string) => void): Promise<ChildRun>;
  activate(input: { slug: string; email: string; typedSlug?: string; actor: string }): Promise<ChildRun>;
  smoke(input: { slug: string; baseUrl: string; cookie: string }, onLine: (line: string) => void): Promise<ChildRun>;
}

/** What the checks before Register settled, for the steps after it. */
export interface SmokePlan {
  slug: string;
  baseUrl: string;
  cookie: string;
  user: string;
  database: DatabaseLocation;
  /** The slug typed with --confirm-replaces, passed to setAppActive(). */
  typedSlug?: string;
}

/** The base URL --smoke tests, as the smoke script would default it. */
export function smokeBaseUrl(request: SmokeRequest, env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBaseUrl(request.baseUrl ?? `http://localhost:${env.PORT || "3000"}`);
}

/** The command that reruns this one with --confirm-replaces. */
function confirmCommand(slug: string, request: SmokeRequest): string {
  return (
    `npm run register -- app/${slug} --smoke` +
    (request.baseUrl ? ` --base-url ${request.baseUrl}` : "") +
    (request.databaseIsDisposable ? " --database-is-disposable" : "") +
    ` --confirm-replaces ${slug}`
  );
}

/** The smoke test on its own, for after a step that stopped --smoke short. */
export function smokeCommand(plan: Pick<SmokePlan, "slug" | "user" | "baseUrl">): string {
  const base = plan.baseUrl === smokeBaseUrl({ databaseIsDisposable: false }) ? "" : ` --base-url ${plan.baseUrl}`;
  return `SMOKE_EMAIL=${plan.user} SMOKE_PASSWORD=<password> npx tsx scripts/smoke-test-app.ts ${plan.slug}${base}`;
}

const NOTHING_REGISTERED = "Nothing was registered.";

/**
 * The checks before Register. A refusal's message ends by saying nothing was
 * registered; a note worth knowing on the way is said through `say`.
 */
export async function smokeBeforeRegister(
  slug: string,
  request: SmokeRequest,
  ctx: { root: string; steps: SmokeSteps; say: (line: string) => void },
): Promise<{ ok: true; plan: SmokePlan } | { ok: false; message: string }> {
  const { steps, say } = ctx;
  const refuse = (...lines: string[]) => ({ ok: false as const, message: [...lines, NOTHING_REGISTERED].join("\n") });

  // 1. Only a database on this machine, unless the caller says it is theirs to throw away.
  const database = steps.database();
  if (!database.local) {
    if (!request.databaseIsDisposable) {
      return refuse(
        `--smoke runs only against a database on this machine, and this checkout's is on ${describeHosts(database)}. ` +
          `Other instances may use it too: --smoke would apply app/${slug}'s migrations there before anyone has ` +
          "reviewed them in a pull request, then turn the app on and grant it for every instance on it.",
        "Point this checkout at a local database, or register without --smoke. If that database is yours " +
          "alone and you can throw it away, add --database-is-disposable.",
      );
    }
    say(
      `This checkout's database is on ${describeHosts(database)}, which you said is disposable, so --smoke ` +
        "applies migrations, activates and grants there.",
    );
  }

  // 2. The server signs in the user the smoke test runs as.
  let baseUrl: string;
  let session: { cookie: string; user: string };
  try {
    baseUrl = smokeBaseUrl(request);
    session = await steps.signIn(baseUrl);
  } catch (err) {
    if (!(err instanceof SmokeSetupError)) throw err;
    return refuse(
      `--smoke signs in to the server to test the app, and couldn't: ${err.message.replace(/\.$/, "")}.`,
      "Start it with `npm run dev`, or pass --base-url, and set SMOKE_EMAIL and SMOKE_PASSWORD, or " +
        "SMOKE_COOKIE, for a user in this checkout's database.",
    );
  }

  try {
    // 3. The server and this command use the same database.
    if (!(await steps.userExists(session.user))) {
      return refuse(
        `The server at ${baseUrl} signed in ${session.user}, who isn't in this checkout's database ` +
          `(${describeHosts(database)}). So the server uses another database, and --smoke would activate ` +
          "and grant the app in the wrong one. Run both against the same database.",
      );
    }

    // 4. An app that replaces a different extension needs its slug typed.
    const read = readInstallRecord(pendingLocation(ctx.root, "app", slug).folder);
    if (read.state === "ok") {
      const identity = extensionIdentity("app", slug, [{ ...read.record, modified: false }]);
      const row = await steps.appRow(slug);
      const changes = row !== null && row.identity !== null && row.identity !== identity;
      const flagged = row !== null && (row.identityChangedAt !== null || changes);
      const typed = request.confirmReplaces;
      if (flagged && typed !== slug) {
        const was = changes ? row.identity : row.replacedIdentity;
        return refuse(
          `app/${slug} replaces a different extension under the same name: this checkout's database knows ` +
            `${slug} as ${describeIdentity(was)}, and this install is ${describeIdentity(identity)}. The ` +
            "release step switches such an app off and revokes its API keys, and activating it gives it the " +
            "grants, settings and data of the extension before it.",
          "To do that knowingly, type its slug:",
          `  ${confirmCommand(slug, request)}`,
          "Or register it without --smoke, then activate it in Admin > Apps, which asks for its slug too.",
        );
      }
      if (!flagged && typed !== undefined) {
        say(`--confirm-replaces ${typed}: ${slug} doesn't replace a different extension, so there is nothing to confirm.`);
      }
    }
  } catch (err) {
    return refuse(
      `--smoke couldn't read this checkout's database (${describeHosts(database)}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    ok: true,
    plan: {
      slug,
      baseUrl,
      cookie: session.cookie,
      user: session.user,
      database,
      ...(request.confirmReplaces === slug ? { typedSlug: slug } : {}),
    },
  };
}

/** An identity as an audit row's details hold it, in a few words. */
function describeReplaced(replaced: IdentityDetails): string {
  if (replaced === null) return "an extension with no recorded identity";
  if (typeof replaced === "string") return replaced === "local" ? "a local extension" : replaced;
  return `the one from ${sourceHost(replaced.source)}, ${replaced.repository.owner}/${replaced.repository.name}`;
}

/** The verdict line: the last line on stdout that parses as one. */
function verdictFrom(stdout: string): Verdict | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as Verdict;
      if (value && typeof value === "object" && typeof value.ok === "boolean" && Array.isArray(value.apps)) return value;
    } catch {
      // Not the verdict.
    }
  }
  return null;
}

/** The last line on stdout, read as smoke-activate.ts's answer. */
function activationFrom(run: ChildRun): SmokeActivation | null {
  const last = run.stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = SmokeActivationSchema.safeParse(JSON.parse(last));
    return parsed.success ? (parsed.data as SmokeActivation) : null;
  } catch {
    return null;
  }
}

/**
 * The steps after Register. Returns the exit code: 0 when the smoke test
 * passed, 1 when a step stopped it or it failed.
 */
export async function smokeAfterRegister(
  plan: SmokePlan,
  ctx: { steps: SmokeSteps; say: (line: string) => void; actor: string },
): Promise<number> {
  const { steps, say } = ctx;
  const { slug } = plan;
  const where = `this checkout's database (${describeHosts(plan.database)})`;
  const rerun = `  ${smokeCommand(plan)}`;

  say("");
  say(`Smoke test: migrating, activating and granting ${slug} in ${where}, then calling its routes at ${plan.baseUrl} as ${plan.user}.`);

  // 1. Its migrations.
  const migrated = await steps.migrate((line) => {
    if (line.trim()) say(`    ${line}`);
  });
  if (migrated.code !== 0) {
    say(
      `npm run migrate:apps failed${migrated.code === null ? " to finish" : ` (exit ${migrated.code})`}, so the ` +
        `smoke test stopped there. ${slug} is registered, and inactive. Fix it and run npm run migrate:apps, ` +
        `then activate ${slug} in Admin > Apps and run the smoke test:`,
    );
    say(rerun);
    return 1;
  }

  // 2. Activate and grant, with Activate's checks and audit rows.
  const run = await steps.activate({ slug, email: plan.user, typedSlug: plan.typedSlug, actor: ctx.actor });
  const activation = activationFrom(run);
  if (!activation) {
    say(`Activating ${slug} failed${run.code === null ? " to finish" : ""}, so the smoke test stopped there:`);
    for (const line of (run.stderr.trim() || run.stdout.trim() || "it said nothing").split("\n")) say(`    ${line}`);
    return 1;
  }
  if (!activation.ok) {
    const next =
      activation.code === "connectors"
        ? `Configure it in Admin > Connectors, activate ${slug} in Admin > Apps, then run the smoke test:`
        : activation.code === "replaces"
          ? `Activate it in Admin > Apps, which asks for its slug, then run the smoke test:`
          : "Then run the smoke test:";
    say(`${activation.message} ${slug} is registered and migrated, and wasn't activated. ${next}`);
    say(rerun);
    return 1;
  }
  say(
    activation.activated
      ? `Activated ${slug} in ${where}` +
          (activation.replaced !== null ? `, in place of ${describeReplaced(activation.replaced)}.` : ".")
      : `${slug} was already active.`,
  );
  say(
    activation.grant === "added"
      ? `Granted ${slug} to ${plan.user}.`
      : activation.grant === "existing"
        ? `${plan.user} already had ${slug}.`
        : `${slug} is a global app, which every user has: nothing to grant.`,
  );

  // 3. The smoke test itself.
  const smoked = await steps.smoke({ slug, baseUrl: plan.baseUrl, cookie: plan.cookie }, say);
  const verdict = verdictFrom(smoked.stdout);
  if (!verdict || verdict.error !== undefined || smoked.code === null || smoked.code === 2) {
    say(
      `The smoke test couldn't run${verdict?.error ? `: ${verdict.error}` : ""}. ${slug} is registered, ` +
        "migrated, active and granted here. Run it again with:",
    );
    say(rerun);
    return 1;
  }
  if (verdict.ok && smoked.code === 0) {
    say(`The smoke test passed. ${slug} stays active and granted in ${where}.`);
    return 0;
  }
  const app: AppResult | undefined = verdict.apps.find((a) => a.slug === slug);
  say(
    `The smoke test failed. Nothing was rolled back: ${slug} stays registered, migrated, active and granted ` +
      "here. Fix it and run the smoke test again:",
  );
  say(rerun);
  if (app?.status === "inactive") {
    say(
      `Every route answered 404, so the server isn't serving ${slug} yet. npm run dev can keep serving what it ` +
        "loaded before an app's folder was replaced: restart it. A production build (npm run start) serves what " +
        "it was built with: build it again and restart it. Then run the smoke test again.",
    );
  }
  return 1;
}

/* -------------------------------------------------------------------------- */
/*  The real steps                                                              */
/* -------------------------------------------------------------------------- */

/** How long each child may take. Migrations and a slow route are minutes at most. */
const MIGRATE_TIMEOUT_MS = 10 * 60_000;
const ACTIVATE_TIMEOUT_MS = 2 * 60_000;
const SMOKE_TIMEOUT_MS = 15 * 60_000;

/**
 * Run `node <tsx> <script> ...args` in `cwd`, passing each line it prints to
 * `onLine` as it comes, and keeping both streams. Exit code null when it was
 * stopped, by `signal` or the time limit, or couldn't start.
 */
export function runChild(
  root: string,
  script: string,
  args: string[],
  opts: {
    env: Readonly<Record<string, string | undefined>>;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Each line on stderr, and on stdout too with `forwardStdout`. */
    onLine?: (line: string) => void;
    /** For a child whose stdout is for people, not an answer to read. */
    forwardStdout?: boolean;
  },
): Promise<ChildRun> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "Stopped before it started." });
      return;
    }
    const ownGroup = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), script, ...args], {
        cwd: root,
        // The cast is only for Next's types, which declare NODE_ENV on every
        // environment. The smoke test's has none, deliberately.
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: ownGroup,
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const out = { stdout: "", stderr: "" };
    const partial = { stdout: "", stderr: "" };
    const take = (stream: "stdout" | "stderr", forward: boolean) => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // Bounded: a runaway child must not fill this process's memory.
      if (out[stream].length < 1_000_000) out[stream] += text;
      if (!forward || !opts.onLine) return;
      const lines = (partial[stream] + text).split("\n");
      partial[stream] = lines.pop() ?? "";
      for (const line of lines) opts.onLine(line.replace(/\r$/, ""));
    };
    // stdout carries the JSON answers the caller reads, unless it is for people too.
    child.stdout?.on("data", take("stdout", opts.forwardStdout === true));
    child.stderr?.on("data", take("stderr", true));
    const kill = () => {
      try {
        if (ownGroup && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    let stopped = false;
    const timer = setTimeout(() => {
      stopped = true;
      kill();
    }, opts.timeoutMs);
    const abort = () => {
      stopped = true;
      kill();
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    const settle = (code: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (opts.onLine) {
        if (opts.forwardStdout && partial.stdout) opts.onLine(partial.stdout);
        if (partial.stderr) opts.onLine(partial.stderr);
      }
      resolve({ code: stopped ? null : code, ...out });
    };
    child.on("error", (err) => {
      out.stderr += `\n${err.message}`;
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}

/**
 * This process's environment, which loadEnv() filled and the migration and the
 * activation need for the database, less the smoke user's credentials, which
 * only the sign-in here and the smoke test's session use.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of ["SMOKE_PASSWORD", "SMOKE_COOKIE", "SMOKE_EMAIL"]) delete out[key];
  return out;
}

/** The steps as they run in a checkout: this process's database pool, and child processes. */
export function checkoutSmokeSteps(root: string, signal?: AbortSignal): SmokeSteps {
  return {
    // The pool Register's lock and audit row use: the same rule, read the same
    // way, as "Activate in this checkout".
    database: () => thisDatabase(),
    signIn: (baseUrl) => signInFromEnv({ baseUrl }),
    userExists: async (email) => {
      const rows = await sql`select 1 from public.users where email = ${email}`;
      return rows.length > 0;
    },
    appRow: async (slug) => {
      const [row] = await sql<
        { is_active: boolean; identity: string | null; identity_changed_at: Date | null; replaced_identity: string | null }[]
      >`select is_active, identity, identity_changed_at, replaced_identity from public.apps where slug = ${slug}`;
      return row
        ? {
            isActive: row.is_active,
            identity: row.identity,
            identityChangedAt: row.identity_changed_at,
            replacedIdentity: row.replaced_identity,
          }
        : null;
    },
    migrate: (onLine) =>
      runChild(root, "scripts/migrate.ts", [], {
        env: childEnv(),
        timeoutMs: MIGRATE_TIMEOUT_MS,
        signal,
        onLine,
        forwardStdout: true,
      }),
    activate: ({ slug, email, typedSlug, actor }) =>
      runChild(
        root,
        "scripts/smoke-activate.ts",
        [slug, "--user", email, "--actor", actor, ...(typedSlug ? ["--typed-slug", typedSlug] : [])],
        { env: childEnv(), timeoutMs: ACTIVATE_TIMEOUT_MS, signal },
      ),
    // The smoke test needs no database and no keys: only the session, and where tsx keeps its cache.
    smoke: ({ slug, baseUrl, cookie }, onLine) =>
      runChild(root, "scripts/smoke-test-app.ts", [slug, "--base-url", baseUrl], {
        env: {
          ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
          ...(process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {}),
          SMOKE_COOKIE: cookie,
        },
        timeoutMs: SMOKE_TIMEOUT_MS,
        signal,
        onLine,
      }),
  };
}
