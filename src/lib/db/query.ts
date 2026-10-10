/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Sql } from "postgres";

/**
 * The platform's query builder — `db.from("users").select("id").eq(...)` — and
 * the engine under every app's `context.db`.
 *
 * WHY IT EXISTS. This used to be supabase-js talking to PostgREST over HTTPS,
 * which made every deployment a Supabase deployment (or one that ran and
 * secured its own PostgREST). The codebase only ever used a small part of that
 * client, so this module speaks that part — same method names, same result
 * shape, same JSON types — directly over the postgres.js pool that analytics and
 * the scheduler already used. One `DATABASE_URL` is now the whole database
 * story, against any Postgres 13 or later: Supabase, Neon, RDS, a container.
 *
 * WHAT "SAME" MEANS, because apps were written and tested against PostgREST:
 *   - Rows are serialized by Postgres with `to_json`, as PostgREST serializes
 *     them with `json_agg`. A timestamptz arrives as an ISO string, numeric and
 *     bigint as JSON numbers, jsonb as parsed values — not as the Date objects
 *     and numeric strings postgres.js hands back from a raw query.
 *   - Writes go through `json_populate_recordset(null::<table>, $1)`, the
 *     mechanism PostgREST itself uses, so the database applies the column
 *     types: an ISO string becomes a timestamptz, a JSON array a text[], an
 *     object a jsonb value.
 *   - A filter value is sent as untyped text and cast by Postgres to the
 *     column's type, exactly as a PostgREST query-string value is.
 *   - Awaiting never rejects because of the database. The result carries
 *     `{ data, error, count, status }`, and `error` has PostgREST's fields —
 *     message, code, details, hint — with the SQLSTATE as the code.
 *   - `.single()` and `.maybeSingle()` keep PostgREST's PGRST116 error, so code
 *     written to detect "no row" against Supabase still detects it. A write
 *     whose returned rows fail that check is rolled back, as PostgREST does.
 *
 * WHAT IS NOT HERE, on purpose: joins (embedded resources), `or()`, raw
 * `filter()`, RPC, JSON-path columns and casts in a select list. A method that
 * does not exist is a compile error, which is the honest failure. The supported
 * surface is listed in docs/apps/database.md.
 *
 * SECURITY. Every identifier — schema, table, column, alias, conflict target —
 * must match a strict pattern and is double-quoted; every value is a bind
 * parameter. Nothing a caller passes is spliced into SQL text. That is what
 * keeps `context.db` inside its own app: the scoped client is this builder
 * pinned to the app's schema (src/lib/apps/scoped-db.ts), and a table name that
 * could carry a quote, a dot or a parenthesis would step outside it. The
 * builder's state lives in private fields for the same reason — an app holding
 * a builder cannot rewrite the schema or table it already names.
 */

/**
 * A row, as callers see it. `any`, matching the untyped PostgREST client this
 * replaced: callers cast rows to their own types at the read boundary, and a
 * stricter type here would turn each of those casts into a compile error
 * without making any of them safer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

/**
 * A failed query. Shaped like PostgREST's error so existing checks keep
 * working: `code` is the SQLSTATE for a database error (`23505` for a unique
 * violation), `PGRST116` for a `.single()` that did not get one row, and
 * `MIXOS_QUERY` for a query this builder refused to build.
 *
 * The message can name tables and columns. Never send it to a browser — see
 * `safeErrorMessage` and apps/AGENTS.md invariant 9.
 */
export class DbError extends Error {
  readonly code: string;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(init: {
    message: string;
    code: string;
    details?: string | null;
    hint?: string | null;
  }) {
    super(init.message);
    this.name = "DbError";
    this.code = init.code;
    this.details = init.details ?? null;
    this.hint = init.hint ?? null;
  }
}

/**
 * What awaiting a query resolves to. A discriminated union, as PostgREST's is,
 * so `if (error) return; data.map(...)` narrows `data` to non-null.
 */
export type DbResponse<T> =
  | { data: T; error: null; count: number | null; status: number; statusText: string }
  | { data: null; error: DbError; count: null; status: number; statusText: string };

export interface SelectOptions {
  /** Also return the number of matching rows. Only `"exact"` exists. */
  count?: "exact";
  /** Return the count alone: `data` is null and no rows are fetched. */
  head?: boolean;
}

export interface UpsertOptions {
  /**
   * Comma-separated columns with a unique constraint over them, e.g.
   * `"user_id,app_slug"`. Defaults to the table's primary key.
   */
  onConflict?: string;
  /** Keep the stored row on a conflict instead of updating it. */
  ignoreDuplicates?: boolean;
}

export interface OrderOptions {
  ascending?: boolean;
  /** Unset means Postgres's default: nulls last ascending, first descending. */
  nullsFirst?: boolean;
}

type Action = "select" | "insert" | "upsert" | "update" | "delete";
type Operator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is";

interface Filter {
  column: string;
  op: Operator;
  value: unknown;
}

interface QueryState {
  schema: string;
  table: string;
  action: Action;
  /**
   * The select list for a read; the RETURNING list for a write, where null
   * means the write returns nothing and `data` is null.
   */
  columns: string | null;
  count: boolean;
  head: boolean;
  filters: Filter[];
  order: { column: string; ascending: boolean; nullsFirst?: boolean }[];
  limit: number | null;
  offset: number | null;
  /** The rows to write; one object for update, one or more for insert/upsert. */
  rows: Record<string, unknown>[];
  /** The columns the write names, in first-seen order. */
  written: string[];
  onConflict: string[] | null;
  ignoreDuplicates: boolean;
  cardinality: "many" | "one" | "maybe-one";
}

/** A query the builder refuses to build. Surfaces as `DbError` code MIXOS_QUERY. */
class QueryError extends Error {}

/** Thrown inside a write's transaction to roll it back when `.single()` fails. */
class CardinalityError extends Error {
  constructor(readonly rows: number) {
    super("cardinality");
  }
}

// ── SQL text ────────────────────────────────────────────────────────────────

/**
 * An unquoted Postgres identifier, and nothing else: no quotes, dots, spaces,
 * parentheses or operators. 63 is NAMEDATALEN - 1. Longer names are refused
 * rather than passed through, because Postgres would silently truncate them
 * and the query would name a different table than the caller wrote.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENTIFIER = 63;

function quote(name: unknown, what: string): string {
  if (typeof name !== "string" || !IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER) {
    throw new QueryError(
      `Invalid ${what} ${JSON.stringify(name)}: use a plain column or table name ` +
        `(letters, digits and underscores, at most ${MAX_IDENTIFIER} characters).`,
    );
  }
  return `"${name}"`;
}

/**
 * A table, always schema-qualified: `public` for the platform's own tables, an
 * app's schema for the client its `context.db` is.
 */
function qualified(schema: string, table: string): string {
  return `${quote(schema, "schema name")}.${quote(table, "table name")}`;
}

/**
 * A select list as SQL over the row alias `alias`, plus whether it is exactly
 * `*`. Accepts `*`, `column` and PostgREST's `alias:column`, comma-separated.
 * Anything else — a cast, a JSON path, an embedded resource — is refused with
 * the item named, rather than half-supported.
 */
function projection(spec: string, alias: string): { sql: string; starOnly: boolean } {
  const items = spec.split(",").map((s) => s.trim());
  const out: string[] = [];
  for (const item of items) {
    if (item === "*") {
      out.push(`${alias}.*`);
      continue;
    }
    const parts = item.split(":").map((s) => s.trim());
    if (item === "" || parts.length > 2 || !parts.every((p) => IDENTIFIER.test(p))) {
      throw new QueryError(
        `Unsupported select item ${JSON.stringify(item)} in ${JSON.stringify(spec)}: only "*", ` +
          `a column name and "alias:column" are supported — no joins, casts, JSON paths or functions.`,
      );
    }
    const [name, column] = parts.length === 2 ? parts : [parts[0], parts[0]];
    out.push(`${alias}.${quote(column, "column")} as ${quote(name, "alias")}`);
  }
  return { sql: out.join(", "), starOnly: items.length === 1 && items[0] === "*" };
}

/** One JSON object per row of `alias`, holding the projected columns. */
function rowJson(spec: string, alias: string): string {
  const p = projection(spec, alias);
  if (p.starOnly) return `to_json(${alias})`;
  // A correlated scalar subquery, not a derived table in FROM: it keeps the
  // outer ORDER BY the thing that orders the result. Aggregating a sorted
  // subquery (PostgREST's json_agg) usually preserves order; this always does.
  return `(select to_json(_p) from (select ${p.sql}) as _p)`;
}

/**
 * A value as JSON can carry it. A Date becomes its ISO string, as
 * JSON.stringify would make it; a bigint becomes a string, which JSON cannot
 * otherwise hold.
 */
function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * A row to write, as JSON carries it. An `undefined` field is left out.
 * `fromEntries` rather than assignment, so every key — `__proto__` included —
 * becomes an own property instead of reaching a setter.
 */
function jsonRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, jsonValue(value)]),
  );
}

/**
 * Bind parameters. Every value the builder binds is either JSON (cast `::json`
 * in the SQL) or text (cast `::text`), never anything postgres.js has to guess
 * at. That matters: postgres.js asks the server what type each untyped
 * parameter is and then re-encodes the JS value for that type, so an untyped
 * "true" bound against a boolean column is sent as `f`, and a JSON string bound
 * against `::json` is stringified a second time.
 */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const COMPARISON: Record<Exclude<Operator, "in" | "is" | "like" | "ilike">, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * The WHERE clause. A compared value is converted to the column's own type by
 * `json_populate_record` against the table — the same conversion a write gets
 * — which is how PostgREST's untyped query-string values behaved: `"3"` and
 * `3` both match an integer, `"true"` a boolean, an ISO string a timestamptz at
 * full microsecond precision. Each conversion is a scalar subquery, so it runs
 * once per statement rather than once per row, and an index on the column
 * stays usable.
 */
function where(filters: Filter[], alias: string, table: string, params: Params): string {
  if (filters.length === 0) return "";
  const clauses = filters.map((f) => {
    const name = quote(f.column, "column");
    const column = `${alias}.${name}`;
    if (f.op === "in") {
      const values = f.value as unknown[];
      // An empty list matches nothing, as in PostgREST.
      if (values.length === 0) return "false";
      const rows = params.add(values.map((v) => ({ [f.column]: jsonValue(v) })));
      return `${column} = any(array(select _f.${name} from json_populate_recordset(null::${table}, ${rows}::json) as _f))`;
    }
    if (f.op === "is") {
      if (f.value === null) return `${column} is null`;
      if (f.value === true) return `${column} is true`;
      if (f.value === false) return `${column} is false`;
      throw new QueryError(`is() takes null, true or false, got ${JSON.stringify(f.value)}.`);
    }
    if (f.op === "like" || f.op === "ilike") {
      if (typeof f.value !== "string") {
        throw new QueryError(`${f.op}() takes a string pattern, got ${JSON.stringify(f.value)}.`);
      }
      // PostgREST spells the LIKE wildcard `*`, because `%` is awkward in a
      // URL, and code written for it may use either.
      return `${column} ${f.op} ${params.add(f.value.replace(/\*/g, "%"))}::text`;
    }
    const value = params.add({ [f.column]: jsonValue(f.value) });
    return `${column} ${COMPARISON[f.op]} (select _f.${name} from json_populate_record(null::${table}, ${value}::json) as _f)`;
  });
  return ` where ${clauses.join(" and ")}`;
}

interface CompiledQuery {
  text: string;
  params: unknown[];
}

/**
 * The SQL for one query. Pure — query.test.ts pins the exact text each call
 * produces, through a stand-in pool. `conflict` is the resolved upsert target:
 * the caller's `onConflict`, or the primary key the executor looked up.
 *
 * `data` is null when nothing needs to run for rows: a `head` count, or an
 * insert of zero rows. Every data statement yields one column, `_r`, holding a
 * row as JSON.
 */
function compile(
  state: QueryState,
  conflict: string[] | null = state.onConflict,
): { data: CompiledQuery | null; count: CompiledQuery | null } {
  const table = qualified(state.schema, state.table);

  if (state.action === "select") {
    const countQuery = state.count
      ? (() => {
          const params = new Params();
          const w = where(state.filters, "_t", table, params);
          return { text: `select count(*) as count from ${table} as _t${w}`, params: params.values };
        })()
      : null;
    if (state.head) return { data: null, count: countQuery };

    const params = new Params();
    const w = where(state.filters, "_t", table, params);
    const order = state.order
      .map(
        (o) =>
          `_t.${quote(o.column, "order column")} ${o.ascending ? "asc" : "desc"}` +
          (o.nullsFirst === undefined ? "" : o.nullsFirst ? " nulls first" : " nulls last"),
      )
      .join(", ");
    const text =
      `select ${rowJson(state.columns ?? "*", "_t")} as _r from ${table} as _t${w}` +
      (order ? ` order by ${order}` : "") +
      (state.limit !== null ? ` limit ${state.limit}` : "") +
      (state.offset !== null ? ` offset ${state.offset}` : "");
    return { data: { text, params: params.values }, count: countQuery };
  }

  if (state.count || state.head) {
    throw new QueryError("A count is only available on select().");
  }
  if (state.order.length > 0 || state.limit !== null || state.offset !== null) {
    throw new QueryError(`order(), limit() and range() are only available on select(), not ${state.action}().`);
  }

  const params = new Params();
  let statement: string;

  if (state.action === "insert" || state.action === "upsert") {
    if (state.filters.length > 0) {
      throw new QueryError(`Filters do not apply to ${state.action}(); it writes the rows it is given.`);
    }
    if (state.rows.length === 0) return { data: null, count: null };
    if (state.written.length === 0) {
      throw new QueryError(`${state.action}() was given rows with no columns.`);
    }
    const cols = state.written.map((c) => quote(c, "column"));
    const payload = params.add(state.rows.map((r) => jsonRow(r)));
    statement =
      `insert into ${table} as _t (${cols.join(", ")}) ` +
      `select ${cols.join(", ")} from json_populate_recordset(null::${table}, ${payload}::json)`;

    if (state.action === "upsert") {
      if (!conflict || conflict.length === 0) {
        throw new QueryError("upsert() needs a conflict target: pass onConflict, or give the table a primary key.");
      }
      const target = conflict.map((c) => quote(c, "onConflict column")).join(", ");
      // Only the columns this write names are overwritten; every other column
      // keeps its stored value. That is PostgREST's merge-duplicates, and the
      // partial upsert docs/apps/database.md promises.
      statement += state.ignoreDuplicates
        ? ` on conflict (${target}) do nothing`
        : ` on conflict (${target}) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`;
    }
  } else if (state.action === "update") {
    if (state.written.length === 0) {
      throw new QueryError("update() was given no columns to set.");
    }
    if (state.filters.length === 0) {
      throw new QueryError("update() without a filter would change every row. Add a filter such as .eq().");
    }
    const cols = state.written.map((c) => quote(c, "column"));
    const payload = params.add(jsonRow(state.rows[0]));
    statement =
      `update ${table} as _t set ${cols.map((c) => `${c} = _v.${c}`).join(", ")} ` +
      `from json_populate_record(null::${table}, ${payload}::json) as _v` +
      where(state.filters, "_t", table, params);
  } else {
    if (state.filters.length === 0) {
      throw new QueryError("delete() without a filter would remove every row. Add a filter such as .eq().");
    }
    statement = `delete from ${table} as _t` + where(state.filters, "_t", table, params);
  }

  if (state.columns === null) {
    return { data: { text: statement, params: params.values }, count: null };
  }
  return {
    data: {
      text:
        `with _w as (${statement} returning ${projection(state.columns, "_t").sql}) ` +
        `select to_json(_w) as _r from _w`,
      params: params.values,
    },
    count: null,
  };
}

// ── execution ───────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  406: "Not Acceptable",
  409: "Conflict",
  503: "Service Unavailable",
};

/** PostgREST's status for an error, so `status` stays meaningful. */
function errorStatus(code: string): number {
  if (code === "PGRST116") return 406;
  if (code === "23505" || code === "23503") return 409;
  if (code === "42P01") return 404;
  if (code === "42501") return 403;
  if (/^(08|57P0)/.test(code) || code.startsWith("CONNECT") || code.startsWith("E")) return 503;
  return 400;
}

function failure(error: DbError): DbResponse<never> {
  const status = errorStatus(error.code);
  return { data: null, error, count: null, status, statusText: STATUS_TEXT[status] ?? "Error" };
}

function success<T>(data: T, count: number | null, status: number): DbResponse<T> {
  return { data, error: null, count, status, statusText: STATUS_TEXT[status] ?? "OK" };
}

function singularError(rows: number): DbError {
  return new DbError({
    message: "JSON object requested, multiple (or no) rows returned",
    code: "PGRST116",
    details: `The result contains ${rows} rows`,
  });
}

function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  if (err instanceof QueryError) return new DbError({ message: err.message, code: "MIXOS_QUERY" });
  const e = err as { message?: unknown; code?: unknown; detail?: unknown; hint?: unknown } | null;
  return new DbError({
    message: typeof e?.message === "string" ? e.message : String(err),
    code: typeof e?.code === "string" ? e.code : "",
    details: typeof e?.detail === "string" ? e.detail : null,
    hint: typeof e?.hint === "string" ? e.hint : null,
  });
}

/**
 * The primary key of `table`, in key order — the default upsert target, as in
 * PostgREST. Looked up per call rather than cached: upserts without an explicit
 * `onConflict` are rare and off the hot path, and a cache would outlive a
 * migration that changed the key.
 */
async function primaryKey(sql: Sql, schema: string, table: string): Promise<string[]> {
  const rows = await sql.unsafe<{ name: string }[]>(
    `select a.attname as name
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = to_regclass($1) and i.indisprimary
      order by array_position(i.indkey::int2[], a.attnum)`,
    [qualified(schema, table)],
  );
  return rows.map((r) => r.name);
}

/**
 * Run compiled SQL on the pool or inside a transaction. The cast is the one
 * place the builder's parameters meet postgres.js's types: each is a JSON value
 * bound as `::json` or a string bound as `::text` (see Params), which
 * postgres.js accepts but which TypeScript cannot see from here.
 */
async function run(db: Pick<Sql, "unsafe">, query: CompiledQuery): Promise<Row[]> {
  return [...(await db.unsafe(query.text, query.params as never[]))];
}

async function execute(sql: Sql, state: QueryState): Promise<DbResponse<Row>> {
  try {
    const conflict =
      state.action === "upsert" && !state.onConflict && state.rows.length > 0
        ? await primaryKey(sql, state.schema, state.table)
        : state.onConflict;
    const compiled = compile(state, conflict);

    // count(*) is a bigint, which postgres.js returns as a string.
    const count = compiled.count
      ? Number((await run(sql, compiled.count))[0]?.count ?? 0)
      : null;

    const writes = state.action !== "select";
    const created = state.action === "insert" || state.action === "upsert";
    const okStatus = created ? 201 : writes && state.columns === null ? 204 : 200;

    if (!compiled.data) {
      // A head count, or an insert of no rows. The latter still answers
      // `.select()` with an empty list, as a PostgREST insert of [] does.
      if (state.head || state.columns === null) return success(null, count, okStatus);
      return cardinal([], state.cardinality, count, okStatus);
    }

    const query = compiled.data;
    if (writes && state.columns === null) {
      await run(sql, query);
      return success(null, count, okStatus);
    }

    if (writes && state.cardinality !== "many") {
      // `.single()` on a write is a promise about how many rows it touched. A
      // write that breaks it is rolled back rather than reported after the
      // fact, which is what PostgREST does and what a caller relying on the
      // error to mean "nothing happened" needs.
      try {
        const rows = await sql.begin(async (tx) => {
          const out = (await run(tx, query)).map((r) => r._r);
          const bad = state.cardinality === "one" ? out.length !== 1 : out.length > 1;
          if (bad) throw new CardinalityError(out.length);
          return out;
        });
        return cardinal(rows as Row[], state.cardinality, count, okStatus);
      } catch (err) {
        if (err instanceof CardinalityError) return failure(singularError(err.rows));
        throw err;
      }
    }

    const rows = (await run(sql, query)).map((r) => r._r);
    return cardinal(rows, state.cardinality, count, okStatus);
  } catch (err) {
    return failure(toDbError(err));
  }
}

function cardinal(
  rows: Row[],
  cardinality: QueryState["cardinality"],
  count: number | null,
  status: number,
): DbResponse<Row> {
  if (cardinality === "many") return success(rows, count, status);
  if (rows.length === 1) return success(rows[0], count, status);
  if (rows.length === 0 && cardinality === "maybe-one") return success(null, count, status);
  return failure(singularError(rows.length));
}

// ── the builder ─────────────────────────────────────────────────────────────

function asRows(values: Row | Row[], action: Action): Record<string, unknown>[] {
  const rows = Array.isArray(values) ? values : [values];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new QueryError(`${action}() takes an object or an array of objects.`);
    }
  }
  return rows as Record<string, unknown>[];
}

/**
 * The columns a write names. For an array, the union of every row's keys —
 * a row missing one writes NULL there — and for a single object only the keys
 * with a defined value, so an `undefined` field takes the column default. Both
 * match what supabase-js sent to PostgREST.
 */
function writtenColumns(rows: Record<string, unknown>[], many: boolean): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (many || value !== undefined) seen.add(key);
    }
  }
  return [...seen];
}

function blankState(schema: string, table: string, action: Action): QueryState {
  return {
    schema,
    table,
    action,
    columns: action === "select" ? "*" : null,
    count: false,
    head: false,
    filters: [],
    order: [],
    limit: null,
    offset: null,
    rows: [],
    written: [],
    onConflict: null,
    ignoreDuplicates: false,
    cardinality: "many",
  };
}

/**
 * Filters, modifiers and the result. Awaitable: the query runs when it is
 * first awaited, once, however many times it is awaited after that.
 */
export class FilterQuery<T> implements PromiseLike<DbResponse<T>> {
  readonly #sql: Sql;
  readonly #state: QueryState;
  /** A builder error, held until the query is awaited, as PostgREST would. */
  #invalid: QueryError | null;
  #result: Promise<DbResponse<T>> | null = null;

  constructor(sql: Sql, state: QueryState, invalid: QueryError | null = null) {
    this.#sql = sql;
    this.#state = state;
    this.#invalid = invalid;
  }

  #filter(column: string, op: Operator, value: unknown): this {
    this.#state.filters.push({ column, op, value });
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.#filter(column, "eq", value);
  }
  neq(column: string, value: unknown): this {
    return this.#filter(column, "neq", value);
  }
  gt(column: string, value: unknown): this {
    return this.#filter(column, "gt", value);
  }
  gte(column: string, value: unknown): this {
    return this.#filter(column, "gte", value);
  }
  lt(column: string, value: unknown): this {
    return this.#filter(column, "lt", value);
  }
  lte(column: string, value: unknown): this {
    return this.#filter(column, "lte", value);
  }
  /** SQL LIKE. `%` or PostgREST's `*` is the wildcard. */
  like(column: string, pattern: string): this {
    return this.#filter(column, "like", pattern);
  }
  ilike(column: string, pattern: string): this {
    return this.#filter(column, "ilike", pattern);
  }
  /** `column IN (...)`. An empty list matches no rows. */
  in(column: string, values: readonly unknown[]): this {
    if (!Array.isArray(values)) {
      this.#invalid ??= new QueryError("in() takes an array of values.");
      return this;
    }
    return this.#filter(column, "in", [...values]);
  }
  /** `IS NULL`, `IS TRUE` or `IS FALSE`. */
  is(column: string, value: null | boolean): this {
    return this.#filter(column, "is", value);
  }
  /** An `eq` for each key: `.match({ user_id, app_slug })`. */
  match(query: Record<string, unknown>): this {
    for (const [column, value] of Object.entries(query)) this.#filter(column, "eq", value);
    return this;
  }

  order(column: string, options: OrderOptions = {}): this {
    this.#state.order.push({
      column,
      ascending: options.ascending ?? true,
      nullsFirst: options.nullsFirst,
    });
    return this;
  }

  limit(count: number): this {
    if (!Number.isInteger(count) || count < 0) {
      this.#invalid ??= new QueryError(`limit() takes a non-negative integer, got ${count}.`);
      return this;
    }
    this.#state.limit = count;
    return this;
  }

  /** Rows `from` through `to`, zero-based and inclusive, as in PostgREST. */
  range(from: number, to: number): this {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      this.#invalid ??= new QueryError(`range() takes integers 0 <= from <= to, got ${from}, ${to}.`);
      return this;
    }
    this.#state.offset = from;
    this.#state.limit = to - from + 1;
    return this;
  }

  /**
   * On a write: return the written rows, with these columns. Without it a
   * write resolves with `data: null`.
   */
  select(columns = "*"): FilterQuery<Row[]> {
    this.#state.columns = columns;
    return this as unknown as FilterQuery<Row[]>;
  }

  /** Exactly one row as an object; anything else is a PGRST116 error. */
  single(): FilterQuery<Row> {
    this.#state.cardinality = "one";
    return this as unknown as FilterQuery<Row>;
  }

  /** One row as an object, or null for none; more than one is an error. */
  maybeSingle(): FilterQuery<Row | null> {
    this.#state.cardinality = "maybe-one";
    return this as unknown as FilterQuery<Row | null>;
  }

  then<R1 = DbResponse<T>, R2 = never>(
    onfulfilled?: ((value: DbResponse<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.#result ??= (
      this.#invalid
        ? Promise.resolve(failure(toDbError(this.#invalid)))
        : execute(this.#sql, this.#state)
    ) as Promise<DbResponse<T>>;
    return this.#result.then(onfulfilled, onrejected);
  }
}

/** The verbs for one table. Each returns a {@link FilterQuery}. */
export class TableQuery {
  readonly #sql: Sql;
  readonly #schema: string;
  readonly #table: string;

  constructor(sql: Sql, schema: string, table: string) {
    this.#sql = sql;
    this.#schema = schema;
    this.#table = table;
  }

  #start<T>(action: Action, build: (state: QueryState) => void): FilterQuery<T> {
    const state = blankState(this.#schema, this.#table, action);
    try {
      build(state);
      return new FilterQuery<T>(this.#sql, state);
    } catch (err) {
      if (err instanceof QueryError) return new FilterQuery<T>(this.#sql, state, err);
      throw err;
    }
  }

  select(columns = "*", options: SelectOptions = {}): FilterQuery<Row[]> {
    return this.#start<Row[]>("select", (s) => {
      if (options.count !== undefined && options.count !== "exact") {
        throw new QueryError(`Only count: "exact" is supported, got ${JSON.stringify(options.count)}.`);
      }
      s.columns = columns;
      s.count = options.count === "exact";
      s.head = options.head === true;
    });
  }

  /**
   * Insert one row or many in one statement. Rows may be ragged: the
   * statement covers the union of their keys, and a row missing one gets NULL.
   * An empty array is a no-op.
   */
  insert(values: Row | Row[]): FilterQuery<null> {
    return this.#start<null>("insert", (s) => {
      s.rows = asRows(values, "insert");
      s.written = writtenColumns(s.rows, Array.isArray(values));
    });
  }

  /**
   * Insert, or on a conflict update the columns this call names and leave
   * every other column as stored. One row or many.
   */
  upsert(values: Row | Row[], options: UpsertOptions = {}): FilterQuery<null> {
    return this.#start<null>("upsert", (s) => {
      s.rows = asRows(values, "upsert");
      s.written = writtenColumns(s.rows, Array.isArray(values));
      s.onConflict = options.onConflict
        ? options.onConflict.split(",").map((c) => c.trim())
        : null;
      s.ignoreDuplicates = options.ignoreDuplicates === true;
    });
  }

  /** Set the given columns on every row the filters match. A filter is required. */
  update(values: Row): FilterQuery<null> {
    return this.#start<null>("update", (s) => {
      if (Array.isArray(values)) throw new QueryError("update() takes one object, not an array.");
      s.rows = asRows(values, "update");
      s.written = writtenColumns(s.rows, false);
    });
  }

  /** Delete every row the filters match. A filter is required. */
  delete(): FilterQuery<null> {
    return this.#start<null>("delete", () => {});
  }
}

/**
 * Every verb, on any table in one schema: `public` unless constructed with
 * another. The platform's own client is the `public` one; an app's
 * `context.db` is one built for the app's schema.
 */
export class DbClient {
  readonly #sql: Sql;
  readonly #schema: string;

  constructor(sql: Sql, schema = "public") {
    this.#sql = sql;
    this.#schema = schema;
  }

  /** The same pool, reaching tables in `schema` instead. */
  schema(schema: string): DbClient {
    return new DbClient(this.#sql, schema);
  }

  from(table: string): TableQuery {
    return new TableQuery(this.#sql, this.#schema, table);
  }
}
