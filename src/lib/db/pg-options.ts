import postgres, { type Options, type Sql } from "postgres";

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
 *    Caveat that motivated shape 2: a password containing `@ : / ? # %` breaks
 *    URL parsing unless it is percent-encoded. Supabase URL-encodes the value
 *    it shows you, so copy it verbatim rather than retyping the password.
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
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) return { url, ssl };

  const required = ["PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"] as const;
  const missing = required.filter((k) => !process.env[k]);
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
    password: process.env.PGPASSWORD!,
    database: process.env.PGDATABASE!,
    ssl,
  };
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
      // Default to TLS. Unset used to mean "plaintext", which was the right
      // default when the database was a sidecar container and the wrong one now
      // that it is a hosted service reached over the public internet. A local
      // Postgres that speaks plaintext must now say PGSSLMODE=disable.
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
 */
export function createPgClient(extra: PgOpts = {}): Sql {
  const conn = connectionFromEnv();
  const options = { prepare: false, ...extra } as PgOpts;

  if ("url" in conn) {
    return postgres(conn.url, { ...options, ssl: conn.ssl });
  }
  return postgres({ ...conn, ...options });
}
