/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEPLOYMENT_SECRETS, OPTIONAL_PLATFORM_KEYS, PLATFORM_KEYS } from "./keys";

/**
 * The server's secrets, taken out of `process.env` once it starts.
 *
 * App code runs in the platform's process, and `process.env` is the one place
 * every secret sits under a known name: anything that reaches `process`, an
 * error reporter that dumps the environment, or a child process that inherits
 * it, gets the database password and every encryption key. So when the server
 * starts, `scrubSecrets()` (from `register()`, src/instrumentation.ts) copies
 * each one here and deletes it from `process.env`, and the platform reads them
 * through `readSecret()`.
 *
 * What it doesn't stop (docs/security-architecture.md §5): code that evades
 * the build's scan can still call the platform's own functions, read
 * `/proc/self/environ` on Linux (deleting a variable doesn't change the
 * process's initial environment block), or inspect the heap. It moves the
 * secrets off the one object everything can name.
 *
 * Kept on the global object under a registered symbol, not in this module:
 * Next bundles `instrumentation.ts`, the proxy and the app's routes as separate
 * entries, which may each hold their own copy of this module, and a
 * development server re-evaluates it on every edit. The symbol is
 * non-enumerable, and the object behind it is frozen.
 *
 * Until `scrubSecrets()` has run, and in scripts and tests, which run as
 * processes of their own, `readSecret()` reads `process.env` as before.
 */

/**
 * Every secret MixOS reads, by environment variable. A function, so that
 * ./keys.ts, which reads its keys through this module, can be loaded first.
 */
export function mixosSecretNames(): readonly string[] {
  return [
    ...Object.values(PLATFORM_KEYS).map((k) => k.env),
    ...Object.values(OPTIONAL_PLATFORM_KEYS).map((k) => k.env),
    ...Object.values(DEPLOYMENT_SECRETS).map((k) => k.env),
    "VAPID_PRIVATE_KEY",
    // The database: a URL holds the password, and so does PGPASSWORD.
    "DATABASE_URL",
    "POSTGRES_URL",
    "PGPASSWORD",
  ];
}

/**
 * Secrets a host puts in the environment that MixOS never reads, taken out
 * too so nothing in the process can: the rest of what Vercel's Neon and
 * Supabase integrations set, Auth.js's older name for its secret, and the
 * first admin's password, which only the seed script reads.
 */
export const HOST_SECRETS: readonly string[] = [
  "NEXTAUTH_SECRET",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NO_SSL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_PASSWORD",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "INITIAL_ADMIN_PASSWORD",
];

const STORE = Symbol.for("mixos.secrets");

type Store = Readonly<Record<string, string>>;

function store(): Store | undefined {
  return (globalThis as { [STORE]?: Store })[STORE];
}

/**
 * Take every secret out of `process.env`, keeping MixOS's own here. Runs once;
 * a second call changes nothing, so a development server re-running
 * `register()` keeps what the first took. Returns the names it took.
 */
export function scrubSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const kept: Record<string, string> = { ...(store() ?? {}) };
  const taken: string[] = [];
  const mine = mixosSecretNames();
  for (const name of [...mine, ...HOST_SECRETS]) {
    const value = env[name];
    if (value === undefined) continue;
    if (mine.includes(name)) kept[name] = value;
    delete env[name];
    taken.push(name);
  }
  Object.defineProperty(globalThis, STORE, {
    value: Object.freeze(kept),
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return taken;
}

/**
 * One of `mixosSecretNames()`, or undefined when it isn't set. Reads
 * `process.env` first, which holds it until the scrub and in scripts and tests,
 * then what the scrub kept.
 */
export function readSecret(name: string): string | undefined {
  if (!mixosSecretNames().includes(name)) {
    throw new Error(`${name} isn't one of the secrets src/lib/env/secrets.ts holds. Add it to mixosSecretNames().`);
  }
  return process.env[name] ?? store()?.[name];
}

/**
 * `process.env` with MixOS's secrets put back, for a reader that takes a whole
 * environment record (src/lib/db/pg-options.ts). A copy: changing it changes
 * nothing.
 */
export function envWithSecrets(): NodeJS.ProcessEnv {
  return { ...(store() ?? {}), ...process.env };
}

/** For tests: forget what the scrub kept. */
export function resetSecretsForTest(): void {
  delete (globalThis as { [STORE]?: Store })[STORE];
}
