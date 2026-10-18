/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Token-bucket rate limiting, backed by Postgres and fronted by an in-memory
 * pre-filter.
 *
 * WHY POSTGRES. In memory alone, a limiter suits a single process only. The
 * deployment is serverless: every function instance holds its own Map, so the
 * documented "60 burst / 10 per second" would be per-instance and, across a
 * fleet that scales with the traffic being limited, close to no limit at all. A
 * security control that reads as enforced and is not is worse than an absent
 * one, because nothing prompts you to add the real thing.
 *
 * THE TWO TIERS, AND WHY THE ORDER IS SOUND. A per-instance bucket sees only a
 * fraction of the traffic, so it drains more slowly than the global bucket and
 * is therefore strictly MORE permissive. That asymmetry is what makes the
 * pre-filter safe:
 *
 *   - memory says DENY  → the global bucket is at least as empty. Short-circuit.
 *   - memory says ALLOW → proves nothing. Ask Postgres.
 *
 * A cold instance starts with a full bucket, so it can only ever be too
 * generous. It can never lock anyone out on its own.
 *
 * FAILING OPEN, DELIBERATELY. If Postgres is unreachable the limiter falls back
 * to the in-memory result and warns. This is a security control failing open,
 * which is worth stating plainly: the alternative is that a database blip takes
 * the whole product down. The fallback degrades to exactly the behaviour this
 * module had before, which was considered acceptable for years — it is not a
 * new exposure, only a rarer one.
 */

import { sql } from "@/lib/db/client";

/** Matches the `scope` check constraint on `rate_buckets` in supabase/migrations/0001_platform_schema.sql. */
export type RateLimitScope = "ip" | "user_app" | "route" | "api_key";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  scope: RateLimitScope;
  /**
   * Distinct per limiter. Prefixed onto `subject` so two limiters on the same
   * axis with different budgets do not share a row. `::` is the separator, for
   * the reason documented in unlock-rate-limit.ts: app slugs contain no colons
   * and IPv6 addresses contain only single ones.
   */
  name: string;
  /** Maximum burst size. */
  maxTokens: number;
  /** Tokens restored per second. */
  refillRatePerSecond: number;
}

export interface RateLimiter {
  /** Charge a token. Postgres is the authority; falls back to memory on failure. */
  consume(identity: string): Promise<RateLimitResult>;
  /**
   * Whether a charge would be allowed now, without making one. This is for a
   * limit that charges only failures: `check` before the work, `consume` after
   * a failure. Postgres is the authority, a memory denial short-circuits, and
   * it falls back to memory on failure, as `consume` does.
   */
  check(identity: string): Promise<RateLimitResult>;
  /** Memory-only view. Never awaits, never authoritative — for diagnostics. */
  peek(identity: string): RateLimitResult;
}

interface Entry {
  tokens: number;
  lastRefill: number;
}

/**
 * A subject is `<limiter name>::<identity>`. Built here so every call site
 * cannot help but agree on the shape.
 */
function subjectFor(name: string, identity: string): string {
  return `${name}::${identity}`;
}

/** What a bucket holding `tokens` answers, without charging it. */
function standing(tokens: number, refillRatePerSecond: number): RateLimitResult {
  return tokens >= 1
    ? { allowed: true, remaining: Math.floor(tokens), retryAfterMs: 0 }
    : {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil(((1 - tokens) / refillRatePerSecond) * 1000),
      };
}

export function createRateLimiter({
  scope,
  name,
  maxTokens,
  refillRatePerSecond,
}: RateLimiterOptions): RateLimiter {
  const store = new Map<string, Entry>();

  // Evict stale entries every 60 seconds to prevent unbounded memory growth.
  const EVICT_INTERVAL_MS = 60_000;
  const STALE_MS = (maxTokens / refillRatePerSecond) * 1000 * 2;
  let lastEvict = Date.now();

  function evictStale(now: number) {
    if (now - lastEvict < EVICT_INTERVAL_MS) return;
    lastEvict = now;
    for (const [key, entry] of store) {
      if (now - entry.lastRefill > STALE_MS) store.delete(key);
    }
  }

  function consumeMemory(identity: string): RateLimitResult {
    const now = Date.now();
    evictStale(now);

    let entry = store.get(identity);
    if (!entry) {
      entry = { tokens: maxTokens, lastRefill: now };
      store.set(identity, entry);
    }

    const elapsed = (now - entry.lastRefill) / 1000;
    entry.tokens = Math.min(maxTokens, entry.tokens + elapsed * refillRatePerSecond);
    entry.lastRefill = now;

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      return { allowed: true, remaining: Math.floor(entry.tokens), retryAfterMs: 0 };
    }

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil(((1 - entry.tokens) / refillRatePerSecond) * 1000),
    };
  }

  /**
   * One statement, no transaction — the same shape as the scheduler's atomic
   * claim. Three details are load-bearing:
   *
   *   1. The refill arithmetic lives in the `do update set` / `where`
   *      expressions, which Postgres evaluates against the LOCKED, current row.
   *      A CTE or an `update ... from (select ...)` reads the statement snapshot
   *      instead and is silently racy under concurrency.
   *   2. **A denied request is not charged, and does not advance `last_refill`.**
   *      The `where` clause gates the update: if the bucket has not refilled to
   *      a whole token, no row is updated, `RETURNING` yields nothing, and
   *      `rows.length === 0` *is* the denial. That is what makes this a token
   *      bucket rather than a debt ledger.
   *   3. `tokens` therefore never goes negative, and `last_refill` only moves
   *      when time was actually spent.
   *
   * Charging on every request and clamping at -1 to "preserve the deficit"
   * would be a permanent-lockout bug, not a stricter limiter: charging on a
   * denial while also resetting `last_refill` means a client
   * arriving at or above the refill rate can never accumulate the uninterrupted
   * gap needed to climb back off the floor, so the bucket denies 100% of
   * traffic forever. The bucket must forget denied requests.
   */
  async function consumePostgres(identity: string): Promise<RateLimitResult> {
    const subject = subjectFor(name, identity);
    const refilled = sql`least(
      ${maxTokens}::float8,
      b.tokens
        + extract(epoch from now() - b.last_refill) * ${refillRatePerSecond}::float8
    )`;

    const rows = (await sql`
      insert into public.rate_buckets as b (scope, subject, tokens, last_refill)
      values (${scope}, ${subject}, ${maxTokens - 1}::float8, now())
      on conflict (scope, subject) do update
      set tokens = ${refilled} - 1,
          last_refill = now(),
          updated_at = now()
      where ${refilled} >= 1
      returning tokens
    `) as unknown as { tokens: number }[];

    if (rows.length > 0) {
      const tokens = Number(rows[0].tokens);
      return { allowed: true, remaining: Math.max(0, Math.floor(tokens)), retryAfterMs: 0 };
    }

    // Denied. A second round trip, on the abuse path only, buys an honest
    // Retry-After instead of a guess — and the row is guaranteed to exist,
    // because only an existing row can fail the `where`.
    const current = (await sql`
      select tokens,
             extract(epoch from now() - last_refill)::float8 as elapsed
      from public.rate_buckets
      where scope = ${scope} and subject = ${subject}
    `) as unknown as { tokens: number; elapsed: number }[];

    const tokens = Math.min(
      maxTokens,
      Number(current[0]?.tokens ?? 0) +
        Number(current[0]?.elapsed ?? 0) * refillRatePerSecond,
    );
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(
        0,
        Math.ceil(((1 - tokens) / refillRatePerSecond) * 1000),
      ),
    };
  }

  /**
   * The bucket as it stands, refilled to now, and nothing charged. A plain
   * read: it writes nothing, so it needs none of the locked-row care above. No
   * row means nobody has been charged lately, which is a full bucket.
   */
  async function checkPostgres(identity: string): Promise<RateLimitResult> {
    const rows = (await sql`
      select least(
               ${maxTokens}::float8,
               tokens
                 + extract(epoch from now() - last_refill) * ${refillRatePerSecond}::float8
             ) as tokens
      from public.rate_buckets
      where scope = ${scope} and subject = ${subjectFor(name, identity)}
    `) as unknown as { tokens: number }[];

    if (rows.length === 0) return { allowed: true, remaining: maxTokens, retryAfterMs: 0 };
    return standing(Number(rows[0].tokens), refillRatePerSecond);
  }

  function peekMemory(identity: string): RateLimitResult {
    const entry = store.get(identity);
    if (!entry) {
      return { allowed: true, remaining: maxTokens, retryAfterMs: 0 };
    }
    const elapsed = (Date.now() - entry.lastRefill) / 1000;
    return standing(
      Math.min(maxTokens, entry.tokens + elapsed * refillRatePerSecond),
      refillRatePerSecond,
    );
  }

  return {
    async consume(identity: string): Promise<RateLimitResult> {
      const memory = consumeMemory(identity);
      // A denial from the lenient tier implies a denial from the strict one.
      if (!memory.allowed) return memory;
      try {
        return await consumePostgres(identity);
      } catch (err) {
        console.warn(
          `[rate-limit] postgres unavailable for "${name}", falling back to in-memory:`,
          err,
        );
        return memory;
      }
    },
    async check(identity: string): Promise<RateLimitResult> {
      // The same two tiers as `consume`: this instance's own charges are a
      // subset of the global ones, so its memory denying settles it.
      const memory = peekMemory(identity);
      if (!memory.allowed) return memory;
      try {
        return await checkPostgres(identity);
      } catch (err) {
        console.warn(
          `[rate-limit] postgres unavailable for "${name}", falling back to in-memory:`,
          err,
        );
        return memory;
      }
    },
    peek: peekMemory,
  };
}

/**
 * Drop buckets nobody has touched in an hour. Called from the cron tick.
 *
 * THE INVARIANT: this TTL must exceed `maxTokens / refillRatePerSecond` for
 * every configured limiter, or GC forgives an abuser mid-penalty. The slowest
 * limiter today is the password re-check (src/lib/auth/recheck-limit.ts) at 5
 * tokens / one every 300 seconds = 1,500 seconds, so an hour leaves ~2.4x
 * headroom. A slower limiter than that needs either a longer TTL here or
 * per-row budget columns to make the delete exact.
 */
export async function pruneRateBuckets(): Promise<number> {
  try {
    const rows = (await sql`
      delete from public.rate_buckets
      where last_refill < now() - interval '1 hour'
      returning 1 as pruned
    `) as unknown as { pruned: number }[];
    return rows.length;
  } catch (err) {
    console.warn("[rate-limit] bucket prune failed:", err);
    return 0;
  }
}
