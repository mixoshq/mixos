import { type Sql } from "postgres";
import { createPgClient } from "./pg-options";

// Cached on globalThis so Next.js dev hot-reload reuses one pool across
// module re-evaluations instead of leaking connections on every edit.
const globalForDb = globalThis as unknown as { __pg?: Sql };

function getSql(): Sql {
  if (globalForDb.__pg) return globalForDb.__pg;
  globalForDb.__pg = createPgClient({
    // Sized for serverless. Each Vercel function instance gets its own pool, so
    // the ceiling is (instances x max) against Supabase's pooler — keep `max`
    // small and let idle connections be reclaimed quickly rather than holding
    // slots open across invocations.
    max: 3,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  });
  return globalForDb.__pg;
}

// Lazy proxy. Constructing the pool — and therefore reading the connection env
// vars — is deferred until the first call or property access. That keeps
// `next build` (which loads server modules to collect page data) working with
// no database reachable, both in CI and during a Vercel build.
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply(_target, thisArg, args) {
    return (getSql() as unknown as (...a: unknown[]) => unknown).apply(
      thisArg,
      args,
    );
  },
  get(_target, prop, receiver) {
    return Reflect.get(getSql() as object, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(getSql() as object, prop);
  },
});
