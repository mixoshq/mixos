/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isIP } from "node:net";
import postgres, { type Options, type Sql } from "postgres";
import { envWithSecrets, readSecret } from "../env/secrets";

/** postgres.js `Options` with no custom type parsers registered. */
type PgOpts = Options<Record<string, never>>;

type ConnectionEnv =
  | { url: string; ssl: PgOpts["ssl"] }
  | {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
      ssl: PgOpts["ssl"];
    };

/**
 * Connection options for the raw postgres.js pool.
 *
 * Two accepted shapes, in priority order:
 *
 * 1. A connection URL — `DATABASE_URL` or `POSTGRES_URL`. This is what the
 *    Vercel <-> Supabase integration injects automatically, and what the
 *    Supabase dashboard hands you. Prefer the **pooler** URL (port 6543,
 *    `...pooler.supabase.com`): Vercel's serverless functions scale to many
 *    short-lived instances, and pointing them at the direct port-5432 endpoint
 *    exhausts Postgres connections quickly.
 *
 *    Caveat that motivated shape 2: postgres.js reads a password containing
 *    `@ : # %` or a space as written, but a `/` or `?` in it ends the part of
 *    the URL it belongs to, and the rest is misread, so those two have to be
 *    percent-encoded (and so does a `%` followed by two hex digits, which is
 *    decoded). Supabase URL-encodes the value it shows you, so copy it verbatim
 *    rather than retyping the password.
 *
 * 2. Discrete `PG*` fields, which pass through with no parsing and therefore no
 *    escaping rules. Useful for a local Postgres.
 *
 * PGSSLMODE accepts `disable`, `require`, `verify-full`. `allow` and `prefer`
 * are rejected because they are libpq's "try TLS, fall back to plaintext"
 * modes — a footgun against a hosted database, where a misconfigured server
 * would silently downgrade you to plaintext.
 */
function connectionFromEnv(): ConnectionEnv {
  const ssl = resolveSsl();
  const url = connectionUrl();
  if (url) return { url, ssl };

  const required = ["PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"] as const;
  const missing = required.filter((k) => !(k === "PGPASSWORD" ? readSecret(k) : process.env[k]));
  if (missing.length) {
    throw new Error(
      `No Postgres connection configured. Set DATABASE_URL (the Supabase ` +
        `pooler connection string), or provide all of: ${required.join(", ")}. ` +
        `Missing: ${missing.join(", ")}.`,
    );
  }

  const portStr = process.env.PGPORT ?? "5432";
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PGPORT must be a positive integer, got "${portStr}".`);
  }

  return {
    host: process.env.PGHOST!,
    port,
    user: process.env.PGUSER!,
    password: readSecret("PGPASSWORD")!,
    database: process.env.PGDATABASE!,
    ssl,
  };
}

/**
 * The connection string connectionFromEnv uses, or undefined when it would
 * fall back to the discrete PG* fields.
 */
export function connectionUrl(env: NodeJS.ProcessEnv = envWithSecrets()): string | undefined {
  return (env.DATABASE_URL ?? env.POSTGRES_URL) || undefined;
}

/** The variable connectionUrl read, so a message can name it without its value. */
export function connectionUrlName(
  env: NodeJS.ProcessEnv = envWithSecrets(),
): "DATABASE_URL" | "POSTGRES_URL" | undefined {
  if (!connectionUrl(env)) return undefined;
  return env.DATABASE_URL !== undefined ? "DATABASE_URL" : "POSTGRES_URL";
}

/**
 * Whether `env` names a database at all, in either shape connectionFromEnv
 * accepts. It says nothing about whether the settings are complete or right:
 * it is how the release step, which must never guess a database, tells
 * "pointed somewhere" from "pointed nowhere".
 */
export function databaseNamed(env: NodeJS.ProcessEnv = envWithSecrets()): boolean {
  return Boolean(connectionUrl(env) || env.PGHOST);
}

function resolveSsl(): PgOpts["ssl"] {
  switch (process.env.PGSSLMODE) {
    case "disable":
      return false;
    case "require":
      return "require";
    case "verify-full":
      return "verify-full";
    case undefined:
    case "":
      // Default to TLS: the database is usually a hosted service reached over
      // the public internet. A local Postgres that speaks plaintext says
      // PGSSLMODE=disable.
      return "require";
    default:
      throw new Error(
        `Unsupported PGSSLMODE="${process.env.PGSSLMODE}". ` +
          `Use one of: disable, require, verify-full.`,
      );
  }
}

/**
 * Build a postgres.js client from the environment.
 *
 * A single constructor for all three callers (the request-path pool, the app
 * migration runner, the admin seeder) because a connection URL cannot simply be
 * spread into the options object — postgres.js takes it as the first positional
 * argument — and getting that wrong silently falls back to libpq defaults
 * against the wrong database.
 *
 * `prepare: false` is set for every caller and is not optional against Supabase:
 * the pooler runs in transaction mode, where prepared statements are not
 * carried across checkouts and named-statement reuse fails.
 *
 * Through Supabase's transaction pooler, each connection also sends one query
 * at a time (`max_pipeline: 1`), unless the caller says otherwise: see
 * `isSupabaseTransactionPooler`.
 */
export function createPgClient(extra: PgOpts = {}): Sql {
  const conn = connectionFromEnv();
  const options = { prepare: false, ...extra } as PgOpts;

  if ("url" in conn) {
    let sql: Sql;
    try {
      sql = postgres(conn.url, { ...options, ssl: conn.ssl });
      // The hosts are known only once postgres.js has read the URL, and a
      // client connects on its first query, so making it again costs nothing.
      if (options.max_pipeline === undefined && pipelinesThroughSupavisor(sql.options)) {
        void sql.end({ timeout: 0 });
        sql = postgres(conn.url, { ...options, max_pipeline: 1, ssl: conn.ssl });
      }
    } catch (err) {
      // Node's URL parser keeps the whole string on its error, as `input`, so
      // logging that error would print the password with it. Say which
      // variable is wrong instead, and drop the original.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ERR_INVALID_URL" && !(err instanceof URIError)) throw err;
      throw invalidConnectionUrl();
    }
    // postgres.js doesn't throw on a URL it misreads: it connects to the wrong
    // place, and the first query fails as a DNS error far from the cause. Both
    // usual causes leave a `:` in a host, which no host name has: a port that
    // isn't a number stays on its host (`db.example.com:port`), and a `/` or
    // `?` in the password cuts the URL short at it (`owner:p`). An IPv6
    // address has more than one `:`, and a socket directory starts with `/`.
    if (sql.options.host.some(misreadHost)) {
      void sql.end({ timeout: 0 });
      throw invalidConnectionUrl();
    }
    return sql;
  }
  const oneAtATime =
    options.max_pipeline === undefined && isSupabaseTransactionPooler(conn.host, conn.port);
  return postgres({ ...conn, ...options, ...(oneAtATime ? { max_pipeline: 1 } : {}) });
}

/**
 * Whether `host` and `port` are Supabase's transaction pooler: Supavisor, on
 * port 6543 of `*.pooler.supabase.com`, the connection docs/hosting/ tells a
 * Supabase install to use.
 *
 * Supavisor before 2.10 hangs on pipelined queries in transaction mode: the
 * queries are sent, and their answers never come. postgres.js pipelines when
 * every connection in the pool is busy, so a page that runs more queries at
 * once than the pool has connections (three, src/lib/db/client.ts) would hang.
 * Supabase doesn't say which Supavisor a project runs, and SQL can't see it, so
 * there each connection sends one query at a time. That costs a round trip
 * between queued queries, which a same-region pooler makes about a
 * millisecond. Port 5432 there is Supavisor in session mode, which is not
 * affected.
 */
export function isSupabaseTransactionPooler(host: string, port: number): boolean {
  return port === 6543 && /(^|\.)pooler\.supabase\.com\.?$/i.test(host.trim());
}

/** Whether any host the client may connect to is Supabase's transaction pooler. */
function pipelinesThroughSupavisor(options: { host: string[]; port: number[] }): boolean {
  return options.host.some((host, i) =>
    isSupabaseTransactionPooler(host, options.port[i] ?? options.port[0] ?? 5432),
  );
}

/** A host a connection URL can't have meant: see createPgClient. */
function misreadHost(host: string): boolean {
  return host.split(":").length === 2 && isIP(host) === 0 && !host.startsWith("/");
}

/** Names the variable that's wrong, and never repeats its value. */
function invalidConnectionUrl(): Error {
  return new Error(
    `${connectionUrlName() ?? "The connection string"} is not a valid connection URL. ` +
      `A port has to be a number, and a password containing / or ? has to be percent-encoded.`,
  );
}
