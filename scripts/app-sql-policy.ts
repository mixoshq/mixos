/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What an app migration may say. Every statement in apps/<slug>/migrations/*.sql
// is parsed by Postgres's own parser (libpg_query, compiled to WebAssembly) and
// checked here before any of it runs: by the registry generator, so a developer
// hears about it on the next build, and by the release step, which is what runs
// the SQL and so is where the check has to hold.
//
// WHY THE APP'S ROLE IS NOT ENOUGH ON ITS OWN. Each app's SQL runs as a role
// that owns the app's schema and nothing else (scripts/app-migrations.ts), so
// the migration itself cannot change a platform table. What it leaves behind is
// another matter. A trigger, a column default, a check, an index expression or a
// view runs later, whenever the table is read or written. When the app does it,
// through `context.db`, that is as the app's role (src/lib/apps/scoped-db.ts).
// When the platform does, as the admin's data viewer and Delete data do, it is
// as the platform's role, which can read every table. A default that called
// query_to_xml() over public.users would copy password hashes into the app's own
// rows on every insert. So an app may create tables and what describes them,
// fill them, and nothing that runs code: no triggers, rules, functions or DO
// blocks, no grants or role changes, no session settings, and no expression
// that calls a function outside ALLOWED_FUNCTIONS or names anything outside the
// app's schema.
//
// WHY A PARSER, AND WHY AN ALLOWLIST. The regex this replaces matched a few
// keywords, let everything else through, and broke `ON CONFLICT` on the way.
// Here every node of every statement must be a kind this file knows, carrying
// only fields it knows, or the statement is refused. Syntax a later Postgres
// adds is refused until someone allows it here on purpose.
//
// The parser is libpg_query's PostgreSQL 18 grammar, the newest; an older
// server meets statements it cannot parse as a syntax error of its own. The
// release step pins standard_conforming_strings, the one setting that changes
// where a string ends, to the value this parser assumes.
//
// Library only.

import type * as PgQuery from "libpg-query";

/** One reason a migration file is refused. */
export interface SqlProblem {
  /** 1-based line in the file. */
  line: number;
  /** The first line of the statement the problem is in, for context. */
  statement: string;
  reason: string;
}

/**
 * The functions app SQL may call, wherever it calls them: a default, a check, a
 * generated column, an index, a view, or a statement that fills a table. Each
 * is a pg_catalog built-in whose result depends only on its arguments (or, for
 * now() and gen_random_uuid(), on the clock and a random number). None reads a
 * table, a file or a setting, runs SQL text, looks up another object by name,
 * or changes anything.
 */
export const ALLOWED_FUNCTIONS: readonly string[] = [
  // Defaults: when a row was written, and a key for it.
  "now",
  "gen_random_uuid",
  // Text: case-folding for case-insensitive keys, lengths for checks, and the
  // trims that TRIM(...) parses to.
  "lower",
  "upper",
  "length",
  "char_length",
  "btrim",
  "ltrim",
  "rtrim",
  // Numbers and time. extract and timezone are what EXTRACT(...) and
  // AT TIME ZONE parse to; similar_to_escape is SIMILAR TO.
  "abs",
  "round",
  "date_trunc",
  "date_part",
  "extract",
  "timezone",
  "similar_to_escape",
  // JSON built from the statement's own values, for seed rows.
  "jsonb_build_object",
  "jsonb_build_array",
  // Aggregates, for a view summarizing the app's own rows.
  "count",
  "sum",
  "avg",
  "min",
  "max",
];

const FUNCTIONS = new Set(ALLOWED_FUNCTIONS);
const CALLABLE = `App SQL can call only these built-ins: ${ALLOWED_FUNCTIONS.join(", ")}.`;

// ── the parser ──────────────────────────────────────────────────────────────

let parser: Promise<typeof PgQuery> | undefined;

/**
 * Loaded on first use rather than at import. The module reads its .wasm file as
 * soon as it is evaluated, and the release step should not depend on that file
 * on a run with no app SQL to check. Bundled into ops/release.cjs, the file has
 * to sit beside the bundle: `npm run build:ops` copies it there.
 */
function loadParser(): Promise<typeof PgQuery> {
  parser ??= (async () => {
    try {
      const mod = await import("libpg-query");
      await mod.loadModule();
      return mod;
    } catch (err) {
      parser = undefined;
      throw new Error(
        `Could not load the SQL parser that checks app migrations (libpg-query): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
  return parser;
}

// ── reading the tree ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A wrapped node, `{ CreateStmt: { ... } }`, as its type and its fields. */
function unwrap(node: unknown): [string, Json] | null {
  if (!isObject(node)) return null;
  const keys = Object.keys(node);
  if (keys.length !== 1) return null;
  const fields = node[keys[0]];
  return isObject(fields) ? [keys[0], fields] : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A possibly qualified name: a list of String nodes, bare or inside a List
 * node. Null when it is anything else.
 */
function nameParts(value: unknown): string[] | null {
  const list = unwrap(value);
  const items = list && list[0] === "List" ? list[1].items : value;
  if (!Array.isArray(items)) return null;
  const parts: string[] = [];
  for (const item of items) {
    const n = unwrap(item);
    if (!n || n[0] !== "String") return null;
    // An empty string is an absent field, and absent fields are omitted.
    parts.push(typeof n[1].sval === "string" ? n[1].sval : "");
  }
  return parts;
}

const SCALAR_NODES = new Set(["String", "Integer", "Float", "Boolean"]);

/** `ALTER_TABLE` and `CreatePolicyStmt` alike, as SQL words. */
function sqlWords(name: string): string {
  return name
    .replace(/^(OBJECT_|AT_)/, "")
    .replace(/Stmt$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toUpperCase();
}

// ── where a problem is reported ─────────────────────────────────────────────

class Scope {
  constructor(
    readonly schema: string,
    private readonly sink: (byteOffset: number, reason: string) => void,
    /** Byte offset of the nearest node with a location: where a problem here is reported. */
    readonly location: number,
    /**
     * Set inside an expression Postgres stores and evaluates later — a default,
     * a check, an index — naming it for the refusal of a subquery.
     */
    readonly stored: string | null,
  ) {}

  /** This scope, reporting at `f`'s own location when it has one. */
  at(f: Json): Scope {
    const loc = typeof f.location === "number" && f.location >= 0 ? f.location : this.location;
    return loc === this.location ? this : new Scope(this.schema, this.sink, loc, this.stored);
  }

  storing(what: string): Scope {
    return new Scope(this.schema, this.sink, this.location, what);
  }

  refuse(reason: string): void {
    this.sink(this.location, reason);
  }
}

function outside(what: string, s: Scope): string {
  return `${what} is outside this app's schema, ${s.schema}. An app migration can reach only its own objects.`;
}

/** pg_catalog's tables and views all start with pg_, and an unqualified name looks there first. */
function reserved(name: string): boolean {
  return /^pg_/i.test(name);
}

function reservedName(name: string): string {
  return `"${name}": names beginning with pg_ belong to Postgres.`;
}

// ── the allowlist ───────────────────────────────────────────────────────────

/**
 * How a field is examined: a scalar (a name, a flag, an option), a wrapped node
 * or a list of them (each examined by its own rule), a struct of a known type
 * stored without a wrapper, or `own` — left to the rule's `check`, which either
 * examines it in context or refuses it.
 */
type Kind = "scalar" | "node" | "nodes" | "own" | { inline: string };

interface Rule {
  /** What the node is, for a refusal that has to name it. */
  label: string;
  fields: Record<string, Kind>;
  /** Checks of the node's own content, run after its other fields are visited. */
  check?: (f: Json, s: Scope) => void;
}

const S = "scalar" as const;
const N = "node" as const;
const L = "nodes" as const;
const OWN = "own" as const;
const inline = (type: string): Kind => ({ inline: type });

/** The constraint kinds a table or column may carry. EXCLUDE is not among them. */
const CONSTRAINTS = new Set([
  "CONSTR_NULL",
  "CONSTR_NOTNULL",
  "CONSTR_DEFAULT",
  "CONSTR_IDENTITY",
  "CONSTR_GENERATED",
  "CONSTR_CHECK",
  "CONSTR_PRIMARY",
  "CONSTR_UNIQUE",
  "CONSTR_FOREIGN",
  "CONSTR_ATTR_DEFERRABLE",
  "CONSTR_ATTR_NOT_DEFERRABLE",
  "CONSTR_ATTR_DEFERRED",
  "CONSTR_ATTR_IMMEDIATE",
  "CONSTR_ATTR_ENFORCED",
  "CONSTR_ATTR_NOT_ENFORCED",
]);

const STORED_EXPRESSION: Record<string, string> = {
  CONSTR_DEFAULT: "a column default",
  CONSTR_CHECK: "a check constraint",
  CONSTR_GENERATED: "a generated column",
};

/** The SQL keywords that read the clock. The rest of this family names the session. */
const SQL_VALUES = new Set([
  "SVFOP_CURRENT_DATE",
  "SVFOP_CURRENT_TIME",
  "SVFOP_CURRENT_TIME_N",
  "SVFOP_CURRENT_TIMESTAMP",
  "SVFOP_CURRENT_TIMESTAMP_N",
  "SVFOP_LOCALTIME",
  "SVFOP_LOCALTIME_N",
  "SVFOP_LOCALTIMESTAMP",
  "SVFOP_LOCALTIMESTAMP_N",
]);

/** Types whose values are looked up as other objects by name: `'public.users'::regclass`. */
const OBJECT_REFERENCE_TYPES = new Set([
  "regclass",
  "regcollation",
  "regconfig",
  "regdictionary",
  "regnamespace",
  "regoper",
  "regoperator",
  "regproc",
  "regprocedure",
  "regrole",
  "regtype",
]);

const INDEX_METHODS = new Set(["btree", "hash", "gist", "gin", "brin", "spgist"]);

/** What ALTER TABLE (and ALTER VIEW, INDEX, SEQUENCE) may do. */
const ALTER_TABLE_COMMANDS = new Set([
  "AT_AddColumn",
  "AT_ColumnDefault",
  "AT_DropNotNull",
  "AT_SetNotNull",
  "AT_SetExpression",
  "AT_DropExpression",
  "AT_SetStatistics",
  "AT_SetOptions",
  "AT_ResetOptions",
  "AT_SetStorage",
  "AT_SetCompression",
  "AT_DropColumn",
  "AT_AddConstraint",
  "AT_AlterConstraint",
  "AT_ValidateConstraint",
  "AT_DropConstraint",
  "AT_AlterColumnType",
  "AT_SetRelOptions",
  "AT_ResetRelOptions",
  // CREATE UNLOGGED TABLE is allowed, so changing one either way is too.
  "AT_SetLogged",
  "AT_SetUnLogged",
  "AT_AddIdentity",
  "AT_SetIdentity",
  "AT_DropIdentity",
]);

function alterTableRefusal(subtype: string): string {
  if (subtype === "AT_ChangeOwner") return OWNERSHIP;
  if (/RowSecurity$/.test(subtype)) {
    return "Row-level security on an app's tables is the platform's to set: every one has it on, with no policies.";
  }
  if (/Trig/.test(subtype)) return "Enabling or disabling triggers is not allowed in an app migration.";
  if (/Rule$/.test(subtype)) return "Rules are not allowed in an app migration.";
  if (/Partition/.test(subtype)) return "Partitioned tables are not supported in app migrations.";
  if (/Inherit|Of$/.test(subtype)) return "Table inheritance and typed tables are not supported in app migrations.";
  if (subtype === "AT_SetTableSpace") return "Tablespaces are not supported in app migrations.";
  return `ALTER TABLE ... ${sqlWords(subtype)} is not supported in an app migration.`;
}

const OWNERSHIP =
  "Ownership is the platform's to manage: everything an app creates belongs to the app's own role.";

/** Kinds of object an app migration may drop, rename or comment on. */
const RELATION_OBJECTS = new Set(["OBJECT_TABLE", "OBJECT_VIEW", "OBJECT_INDEX", "OBJECT_SEQUENCE"]);

function ownName(value: unknown, s: Scope, what: string): void {
  const parts = nameParts(value);
  if (!parts || parts.length === 0 || parts.length > 2) {
    s.refuse(`This ${what} name cannot be read.`);
    return;
  }
  if (parts.length === 2 && parts[0] !== s.schema) s.refuse(outside(`The ${what} "${parts.join(".")}"`, s));
  if (reserved(parts[parts.length - 1])) s.refuse(reservedName(parts[parts.length - 1]));
}

/** `table.column` or `schema.table.column`, as COMMENT ON COLUMN and OWNED BY name them. */
function ownColumnName(value: unknown, s: Scope, what: string): void {
  const parts = nameParts(value);
  if (!parts || parts.length < 2 || parts.length > 3) {
    s.refuse(`This ${what} name cannot be read.`);
    return;
  }
  if (parts.length === 3 && parts[0] !== s.schema) s.refuse(outside(`"${parts.join(".")}"`, s));
  const table = parts[parts.length - 2];
  if (reserved(table)) s.refuse(reservedName(table));
}

function operatorName(value: unknown, s: Scope): void {
  if (value === undefined) return;
  const parts = nameParts(value);
  if (!parts || parts.length === 0 || parts.length > 2) {
    s.refuse("This operator name cannot be read.");
  } else if (parts.length === 2 && parts[0] !== "pg_catalog") {
    s.refuse(`OPERATOR(${parts.join(".")}) is outside pg_catalog: app SQL can use only the built-in operators.`);
  }
}

/** A collation, an operator class: a built-in name, or one qualified with `allowed`. */
function catalogName(value: unknown, s: Scope, what: string, allowed: readonly string[]): void {
  if (value === undefined) return;
  const parts = nameParts(value);
  if (!parts || parts.length === 0 || parts.length > 2) {
    s.refuse(`This ${what} name cannot be read.`);
  } else if (parts.length === 2 && !allowed.includes(parts[0])) {
    s.refuse(outside(`The ${what} "${parts.join(".")}"`, s));
  }
}

const DEF_ELEM_FIELDS = new Set(["defnamespace", "defname", "arg", "defaction", "location"]);

/** Each DefElem in `list`, or a refusal for anything else in it. */
function defElems(list: unknown, s: Scope): [Json, Scope][] {
  const out: [Json, Scope][] = [];
  for (const item of asList(list)) {
    const n = unwrap(item);
    if (!n || n[0] !== "DefElem" || !Object.keys(n[1]).every((k) => DEF_ELEM_FIELDS.has(k))) {
      s.refuse("This option list cannot be read.");
      continue;
    }
    out.push([n[1], s.at(n[1])]);
  }
  return out;
}

function isScalarNode(value: unknown): boolean {
  const n = unwrap(value);
  return n !== null && SCALAR_NODES.has(n[0]);
}

/** `WITH (fillfactor = 70)` on a table, index or view: storage parameters, plain values only. */
function storageOptions(list: unknown, s: Scope): void {
  for (const [d, here] of defElems(list, s)) {
    if (d.defnamespace !== undefined && d.defnamespace !== "toast") {
      here.refuse(`The option "${d.defnamespace}.${d.defname}" is not supported.`);
    }
    if (d.arg !== undefined && !isScalarNode(d.arg)) {
      here.refuse(`The option "${d.defname}" takes a plain value here.`);
    }
  }
}

const SEQUENCE_OPTIONS = new Set([
  "as",
  "increment",
  "minvalue",
  "maxvalue",
  "start",
  "restart",
  "cache",
  "cycle",
  "owned_by",
  "sequence_name",
  "generated",
  "logged",
  "unlogged",
]);

/** CREATE/ALTER SEQUENCE and identity columns: numbers, a type, and names that stay in the schema. */
function sequenceOptions(list: unknown, s: Scope): void {
  for (const [d, here] of defElems(list, s)) {
    const name = typeof d.defname === "string" ? d.defname : "";
    if (!SEQUENCE_OPTIONS.has(name) || d.defnamespace !== undefined) {
      here.refuse(`The sequence option "${name}" is not supported.`);
      continue;
    }
    if (name === "as") {
      const t = unwrap(d.arg);
      if (t && t[0] === "TypeName") visitAs("TypeName", t[1], here);
      else here.refuse("AS takes a type.");
    } else if (name === "owned_by") {
      const parts = nameParts(d.arg);
      if (!(parts?.length === 1 && parts[0] === "none")) ownColumnName(d.arg, here, "OWNED BY");
    } else if (name === "sequence_name") {
      ownName(d.arg, here, "sequence");
    } else if (d.arg !== undefined && !isScalarNode(d.arg)) {
      here.refuse(`The sequence option "${name}" takes a plain value.`);
    }
  }
}

const RULES: Record<string, Rule> = {
  // ── names and literals ──
  RangeVar: {
    label: "a table name",
    fields: {
      catalogname: OWN,
      schemaname: OWN,
      relname: OWN,
      inh: S,
      relpersistence: OWN,
      alias: inline("Alias"),
      location: S,
    },
    check(f, s) {
      const rel = typeof f.relname === "string" ? f.relname : "";
      const name = typeof f.schemaname === "string" ? `${f.schemaname}.${rel}` : rel;
      if (f.catalogname !== undefined) s.refuse(`"${f.catalogname}.${name}" names another database.`);
      else if (f.schemaname !== undefined && f.schemaname !== s.schema) s.refuse(outside(`"${name}"`, s));
      if (reserved(rel)) s.refuse(reservedName(rel));
      if (f.relpersistence === "t") s.refuse("Temporary tables, views and sequences are not supported.");
      else if (f.relpersistence !== undefined && f.relpersistence !== "p" && f.relpersistence !== "u") {
        s.refuse(`"${name}" has a persistence app migrations do not support.`);
      }
    },
  },
  Alias: { label: "an alias", fields: { aliasname: S, colnames: L } },
  TypeName: {
    label: "a type",
    fields: {
      names: OWN,
      typeOid: S,
      setof: OWN,
      pct_type: OWN,
      typmods: L,
      typemod: S,
      arrayBounds: L,
      location: S,
    },
    check(f, s) {
      const parts = nameParts(f.names);
      if (!parts || parts.length === 0 || parts.length > 2) {
        s.refuse("This type name cannot be read.");
        return;
      }
      if (parts.length === 2 && parts[0] !== "pg_catalog" && parts[0] !== s.schema) {
        s.refuse(outside(`The type "${parts.join(".")}"`, s));
      }
      const name = parts[parts.length - 1];
      if (OBJECT_REFERENCE_TYPES.has(name)) {
        s.refuse(`The type ${name} looks up other database objects by name, and is not allowed.`);
      }
      if (f.setof) s.refuse("SETOF is not supported here.");
      if (f.pct_type) s.refuse("%TYPE is not supported here.");
    },
  },
  A_Const: {
    label: "a constant",
    fields: { ival: OWN, fval: OWN, boolval: OWN, sval: OWN, bsval: OWN, isnull: S, location: S },
  },
  String: { label: "a name", fields: { sval: S } },
  Integer: { label: "a number", fields: { ival: S } },
  Float: { label: "a number", fields: { fval: S } },
  Boolean: { label: "a boolean", fields: { boolval: S } },
  BitString: { label: "a bit string", fields: { bsval: S } },
  List: { label: "a list", fields: { items: L } },

  // ── expressions ──
  ColumnRef: {
    label: "a column reference",
    fields: { fields: OWN, location: S },
    check(f, s) {
      const parts: string[] = [];
      for (const item of asList(f.fields)) {
        const n = unwrap(item);
        if (n && n[0] === "String") parts.push(typeof n[1].sval === "string" ? n[1].sval : "");
        else if (n && n[0] === "A_Star") parts.push("*");
        else {
          s.refuse("This column reference cannot be read.");
          return;
        }
      }
      if (parts.length > 3 || (parts.length === 3 && parts[0] !== s.schema)) {
        s.refuse(outside(`"${parts.join(".")}"`, s));
      }
    },
  },
  A_Expr: {
    label: "an operator",
    fields: {
      kind: S,
      name: OWN,
      lexpr: N,
      rexpr: N,
      rexpr_list_start: S,
      rexpr_list_end: S,
      location: S,
    },
    check(f, s) {
      operatorName(f.name, s);
    },
  },
  TypeCast: { label: "a cast", fields: { arg: N, typeName: inline("TypeName"), location: S } },
  CollateClause: {
    label: "a COLLATE clause",
    fields: { arg: N, collname: OWN, location: S },
    check(f, s) {
      catalogName(f.collname, s, "collation", ["pg_catalog", s.schema]);
    },
  },
  FuncCall: {
    label: "a function call",
    fields: {
      funcname: OWN,
      args: L,
      agg_order: L,
      agg_filter: N,
      over: inline("WindowDef"),
      agg_within_group: S,
      agg_star: S,
      agg_distinct: S,
      func_variadic: S,
      funcformat: S,
      location: S,
    },
    check(f, s) {
      const parts = nameParts(f.funcname);
      if (!parts || parts.length === 0 || parts.length > 2) {
        s.refuse("This function name cannot be read.");
        return;
      }
      const name = parts[parts.length - 1];
      if (parts.length === 2 && parts[0] !== "pg_catalog") {
        s.refuse(`${parts.join(".")}() is outside pg_catalog. ${CALLABLE}`);
      } else if (!FUNCTIONS.has(name)) {
        s.refuse(`${name}() is not allowed. ${CALLABLE}`);
      }
    },
  },
  SQLValueFunction: {
    label: "a SQL value function",
    fields: { op: OWN, type: S, typmod: S, location: S },
    check(f, s) {
      if (!SQL_VALUES.has(String(f.op))) {
        const keyword = String(f.op).replace(/^SVFOP_/, "").replace(/_N$/, "");
        s.refuse(
          `${keyword} is not allowed: it names the session, and a default or view built on it would describe the platform's.`,
        );
      }
    },
  },
  A_Star: { label: "*", fields: {} },
  A_Indices: { label: "a subscript", fields: { is_slice: S, lidx: N, uidx: N } },
  A_Indirection: { label: "a field or subscript", fields: { arg: N, indirection: L } },
  A_ArrayExpr: { label: "an ARRAY", fields: { elements: L, list_start: S, list_end: S, location: S } },
  BoolExpr: { label: "AND, OR or NOT", fields: { boolop: S, args: L, location: S } },
  NullTest: {
    label: "IS NULL",
    fields: { arg: N, nulltesttype: S, argisrow: S, location: S },
  },
  BooleanTest: { label: "IS TRUE", fields: { arg: N, booltesttype: S, location: S } },
  CaseExpr: {
    label: "CASE",
    fields: { casetype: S, casecollid: S, arg: N, args: L, defresult: N, location: S },
  },
  CaseWhen: { label: "WHEN", fields: { expr: N, result: N, location: S } },
  CoalesceExpr: {
    label: "COALESCE",
    fields: { coalescetype: S, coalescecollid: S, args: L, location: S },
  },
  MinMaxExpr: {
    label: "GREATEST or LEAST",
    fields: {
      minmaxtype: S,
      minmaxcollid: S,
      inputcollid: S,
      op: S,
      args: L,
      location: S,
    },
  },
  RowExpr: {
    label: "ROW",
    fields: { args: L, row_typeid: S, row_format: S, colnames: L, location: S },
  },
  NamedArgExpr: {
    label: "a named argument",
    fields: { arg: N, name: S, argnumber: S, location: S },
  },
  SetToDefault: {
    label: "DEFAULT",
    fields: { typeId: S, typeMod: S, collation: S, location: S },
  },
  SubLink: {
    label: "a subquery",
    fields: {
      subLinkType: S,
      subLinkId: S,
      testexpr: N,
      operName: OWN,
      subselect: N,
      location: S,
    },
    check(f, s) {
      if (s.stored) s.refuse(`A subquery is not allowed in ${s.stored}.`);
      operatorName(f.operName, s);
    },
  },

  // ── queries ──
  SelectStmt: {
    label: "SELECT",
    fields: {
      distinctClause: L,
      intoClause: OWN,
      targetList: L,
      fromClause: L,
      whereClause: N,
      groupClause: L,
      groupDistinct: S,
      havingClause: N,
      windowClause: L,
      valuesLists: L,
      sortClause: L,
      limitOffset: N,
      limitCount: N,
      limitOption: S,
      lockingClause: OWN,
      withClause: inline("WithClause"),
      op: S,
      all: S,
      larg: inline("SelectStmt"),
      rarg: inline("SelectStmt"),
    },
    check(f, s) {
      if (f.intoClause !== undefined) {
        s.refuse("SELECT INTO is not supported: create the table, then INSERT ... SELECT into it.");
      }
      if (f.lockingClause !== undefined) s.refuse("FOR UPDATE and FOR SHARE are not supported here.");
    },
  },
  ResTarget: { label: "a column", fields: { name: S, indirection: L, val: N, location: S } },
  MultiAssignRef: { label: "a multiple assignment", fields: { source: N, colno: S, ncolumns: S } },
  SortBy: {
    label: "ORDER BY",
    fields: { node: N, sortby_dir: S, sortby_nulls: S, useOp: OWN, location: S },
    check(f, s) {
      operatorName(f.useOp, s);
    },
  },
  WindowDef: {
    label: "a window",
    fields: {
      name: S,
      refname: S,
      partitionClause: L,
      orderClause: L,
      frameOptions: S,
      startOffset: N,
      endOffset: N,
      location: S,
    },
  },
  RangeSubselect: { label: "a subquery in FROM", fields: { lateral: S, subquery: N, alias: inline("Alias") } },
  RangeFunction: {
    label: "a function in FROM",
    fields: {
      lateral: S,
      ordinality: S,
      is_rowsfrom: S,
      functions: L,
      alias: inline("Alias"),
      coldeflist: L,
    },
  },
  JoinExpr: {
    label: "a JOIN",
    fields: {
      jointype: S,
      isNatural: S,
      larg: N,
      rarg: N,
      usingClause: L,
      join_using_alias: inline("Alias"),
      quals: N,
      alias: inline("Alias"),
      rtindex: S,
    },
  },
  WithClause: { label: "WITH", fields: { ctes: L, recursive: S, location: S } },
  CommonTableExpr: {
    label: "a WITH query",
    fields: {
      ctename: S,
      aliascolnames: L,
      ctematerialized: S,
      ctequery: N,
      search_clause: OWN,
      cycle_clause: OWN,
      location: S,
      cterecursive: S,
      cterefcount: S,
      ctecolnames: L,
      ctecoltypes: L,
      ctecoltypmods: L,
      ctecolcollations: L,
    },
    check(f, s) {
      if (f.search_clause !== undefined || f.cycle_clause !== undefined) {
        s.refuse("SEARCH and CYCLE clauses are not supported.");
      }
    },
  },
  InsertStmt: {
    label: "INSERT",
    fields: {
      relation: inline("RangeVar"),
      cols: L,
      selectStmt: N,
      onConflictClause: inline("OnConflictClause"),
      returningClause: inline("ReturningClause"),
      withClause: inline("WithClause"),
      override: S,
    },
  },
  UpdateStmt: {
    label: "UPDATE",
    fields: {
      relation: inline("RangeVar"),
      targetList: L,
      whereClause: N,
      fromClause: L,
      returningClause: inline("ReturningClause"),
      withClause: inline("WithClause"),
    },
  },
  DeleteStmt: {
    label: "DELETE",
    fields: {
      relation: inline("RangeVar"),
      usingClause: L,
      whereClause: N,
      returningClause: inline("ReturningClause"),
      withClause: inline("WithClause"),
    },
  },
  OnConflictClause: {
    label: "ON CONFLICT",
    fields: { action: S, infer: inline("InferClause"), targetList: L, whereClause: N, location: S },
  },
  InferClause: { label: "a conflict target", fields: { indexElems: L, whereClause: N, conname: S, location: S } },
  ReturningClause: { label: "RETURNING", fields: { options: L, exprs: L } },
  ReturningOption: { label: "a RETURNING option", fields: { option: S, value: S, location: S } },
  TruncateStmt: { label: "TRUNCATE", fields: { relations: L, restart_seqs: S, behavior: S } },

  // ── tables ──
  CreateStmt: {
    label: "CREATE TABLE",
    fields: {
      relation: inline("RangeVar"),
      tableElts: L,
      inhRelations: OWN,
      partbound: OWN,
      partspec: OWN,
      ofTypename: OWN,
      constraints: L,
      nnconstraints: L,
      options: OWN,
      oncommit: S,
      tablespacename: OWN,
      accessMethod: OWN,
      if_not_exists: S,
    },
    check(f, s) {
      if (asList(f.inhRelations).length > 0) s.refuse("Table inheritance (INHERITS) is not supported in app migrations.");
      if (f.partbound !== undefined || f.partspec !== undefined) {
        s.refuse("Partitioned tables are not supported in app migrations.");
      }
      if (f.ofTypename !== undefined) s.refuse("Typed tables (OF type) are not supported in app migrations.");
      if (f.tablespacename !== undefined) s.refuse("Tablespaces are not supported in app migrations.");
      if (f.accessMethod !== undefined && f.accessMethod !== "heap") {
        s.refuse(`The table access method "${String(f.accessMethod)}" is not supported.`);
      }
      storageOptions(f.options, s);
    },
  },
  ColumnDef: {
    label: "a column definition",
    fields: {
      colname: S,
      typeName: inline("TypeName"),
      compression: S,
      inhcount: S,
      is_local: S,
      is_not_null: S,
      is_from_type: S,
      storage: S,
      storage_name: S,
      raw_default: OWN,
      cooked_default: OWN,
      identity: S,
      identitySequence: inline("RangeVar"),
      generated: S,
      collClause: inline("CollateClause"),
      collOid: S,
      constraints: L,
      fdwoptions: OWN,
      location: S,
    },
    check(f, s) {
      // ALTER COLUMN ... TYPE puts its USING expression here, and sets `stored` to say so.
      if (f.raw_default !== undefined) visit(f.raw_default, s.storing(s.stored ?? "a column default"));
      if (f.cooked_default !== undefined) s.refuse("This column definition cannot be read.");
      if (f.fdwoptions !== undefined) s.refuse("Foreign-table options are not supported.");
    },
  },
  Constraint: {
    label: "a constraint",
    fields: {
      contype: OWN,
      conname: S,
      deferrable: S,
      initdeferred: S,
      is_enforced: S,
      skip_validation: S,
      initially_valid: S,
      is_no_inherit: S,
      raw_expr: OWN,
      cooked_expr: OWN,
      generated_when: S,
      generated_kind: S,
      nulls_not_distinct: S,
      keys: L,
      without_overlaps: S,
      including: L,
      exclusions: OWN,
      options: OWN,
      indexname: S,
      indexspace: OWN,
      reset_default_tblspc: S,
      access_method: OWN,
      where_clause: OWN,
      pktable: inline("RangeVar"),
      fk_attrs: L,
      pk_attrs: L,
      fk_with_period: S,
      pk_with_period: S,
      fk_matchtype: S,
      fk_upd_action: S,
      fk_del_action: S,
      fk_del_set_cols: L,
      old_conpfeqop: OWN,
      old_pktable_oid: S,
      location: S,
    },
    check(f, s) {
      const contype = String(f.contype);
      if (!CONSTRAINTS.has(contype)) {
        s.refuse(
          contype === "CONSTR_EXCLUSION"
            ? "EXCLUDE constraints are not supported in app migrations."
            : `The constraint ${sqlWords(contype.replace(/^CONSTR_/, ""))} is not supported.`,
        );
        return;
      }
      if (f.raw_expr !== undefined) visit(f.raw_expr, s.storing(STORED_EXPRESSION[contype] ?? "a constraint"));
      if (contype === "CONSTR_IDENTITY") sequenceOptions(f.options, s);
      else storageOptions(f.options, s);
      if (f.indexspace !== undefined) s.refuse("Tablespaces are not supported in app migrations.");
      for (const field of ["cooked_expr", "exclusions", "access_method", "where_clause", "old_conpfeqop"]) {
        if (f[field] !== undefined) s.refuse("This constraint cannot be read.");
      }
    },
  },
  ATAlterConstraint: {
    label: "ALTER CONSTRAINT",
    fields: {
      conname: S,
      alterEnforceability: S,
      is_enforced: S,
      alterDeferrability: S,
      deferrable: S,
      initdeferred: S,
      alterInheritability: S,
      noinherit: S,
    },
  },
  TableLikeClause: { label: "LIKE", fields: { relation: inline("RangeVar"), options: S, relationOid: S } },
  IndexStmt: {
    label: "CREATE INDEX",
    fields: {
      idxname: S,
      relation: inline("RangeVar"),
      accessMethod: OWN,
      tableSpace: OWN,
      indexParams: L,
      indexIncludingParams: L,
      options: OWN,
      whereClause: OWN,
      excludeOpNames: OWN,
      idxcomment: S,
      indexOid: S,
      oldNumber: S,
      oldCreateSubid: S,
      oldFirstRelfilelocatorSubid: S,
      unique: S,
      nulls_not_distinct: S,
      primary: S,
      isconstraint: S,
      iswithoutoverlaps: S,
      deferrable: S,
      initdeferred: S,
      transformed: S,
      concurrent: OWN,
      if_not_exists: S,
      reset_default_tblspc: S,
    },
    check(f, s) {
      if (f.accessMethod !== undefined && !INDEX_METHODS.has(String(f.accessMethod))) {
        s.refuse(`The index method "${String(f.accessMethod)}" is not supported: use one of ${[...INDEX_METHODS].join(", ")}.`);
      }
      if (f.tableSpace !== undefined) s.refuse("Tablespaces are not supported in app migrations.");
      if (f.excludeOpNames !== undefined) s.refuse("This index cannot be read.");
      if (f.concurrent) {
        s.refuse("CONCURRENTLY cannot run inside the transaction each migration runs in. Leave it out.");
      }
      storageOptions(f.options, s);
      if (f.whereClause !== undefined) visit(f.whereClause, s.storing("an index predicate"));
    },
  },
  IndexElem: {
    label: "an index column",
    fields: {
      name: S,
      expr: OWN,
      indexcolname: S,
      collation: OWN,
      opclass: OWN,
      opclassopts: OWN,
      ordering: S,
      nulls_ordering: S,
    },
    check(f, s) {
      if (f.expr !== undefined) visit(f.expr, s.storing("an index expression"));
      catalogName(f.collation, s, "collation", ["pg_catalog", s.schema]);
      catalogName(f.opclass, s, "operator class", ["pg_catalog"]);
      storageOptions(f.opclassopts, s);
    },
  },
  ViewStmt: {
    label: "CREATE VIEW",
    fields: {
      view: inline("RangeVar"),
      aliases: L,
      query: OWN,
      replace: S,
      options: OWN,
      withCheckOption: S,
    },
    check(f, s) {
      const query = unwrap(f.query);
      if (query && query[0] === "SelectStmt") visitAs("SelectStmt", query[1], s);
      else s.refuse("A view must be a SELECT.");
      storageOptions(f.options, s);
    },
  },
  AlterTableStmt: {
    label: "ALTER TABLE",
    fields: { relation: inline("RangeVar"), cmds: L, objtype: OWN, missing_ok: S },
    check(f, s) {
      if (!RELATION_OBJECTS.has(String(f.objtype))) {
        s.refuse(`ALTER ${sqlWords(String(f.objtype))} is not supported in an app migration.`);
      }
    },
  },
  AlterTableCmd: {
    label: "an ALTER TABLE action",
    fields: {
      subtype: OWN,
      name: S,
      num: S,
      newowner: OWN,
      def: OWN,
      behavior: S,
      missing_ok: S,
      recurse: S,
    },
    check(f, s) {
      const subtype = String(f.subtype);
      if (!ALTER_TABLE_COMMANDS.has(subtype) || f.newowner !== undefined) {
        s.refuse(alterTableRefusal(subtype));
        return;
      }
      if (f.def === undefined) return;
      switch (subtype) {
        case "AT_ColumnDefault":
          visit(f.def, s.storing("a column default"));
          break;
        case "AT_SetExpression":
          visit(f.def, s.storing("a generated column"));
          break;
        case "AT_AlterColumnType":
          visit(f.def, s.storing("a USING expression"));
          break;
        case "AT_SetIdentity":
          sequenceOptions(unwrap(f.def)?.[1]?.items, s);
          break;
        case "AT_SetRelOptions":
        case "AT_ResetRelOptions":
        case "AT_SetOptions":
        case "AT_ResetOptions":
          storageOptions(unwrap(f.def)?.[1]?.items, s);
          break;
        default:
          visit(f.def, s);
      }
    },
  },

  // ── sequences and enum types ──
  CreateSeqStmt: {
    label: "CREATE SEQUENCE",
    fields: { sequence: inline("RangeVar"), options: OWN, ownerId: S, for_identity: S, if_not_exists: S },
    check(f, s) {
      sequenceOptions(f.options, s);
    },
  },
  AlterSeqStmt: {
    label: "ALTER SEQUENCE",
    fields: { sequence: inline("RangeVar"), options: OWN, for_identity: S, missing_ok: S },
    check(f, s) {
      sequenceOptions(f.options, s);
    },
  },
  CreateEnumStmt: {
    label: "CREATE TYPE ... AS ENUM",
    fields: { typeName: OWN, vals: L },
    check(f, s) {
      ownName(f.typeName, s, "type");
    },
  },
  AlterEnumStmt: {
    label: "ALTER TYPE",
    fields: {
      typeName: OWN,
      oldVal: S,
      newVal: S,
      newValNeighbor: S,
      newValIsAfter: S,
      skipIfNewValExists: S,
    },
    check(f, s) {
      ownName(f.typeName, s, "type");
    },
  },

  // ── removing, renaming, describing ──
  DropStmt: {
    label: "DROP",
    fields: { objects: OWN, removeType: OWN, behavior: S, missing_ok: S, concurrent: OWN },
    check(f, s) {
      const kind = String(f.removeType);
      if (!RELATION_OBJECTS.has(kind) && kind !== "OBJECT_TYPE") {
        s.refuse(`DROP ${sqlWords(kind)} is not allowed in an app migration.`);
        return;
      }
      if (f.concurrent) s.refuse("CONCURRENTLY cannot run inside the transaction each migration runs in. Leave it out.");
      for (const object of asList(f.objects)) {
        if (kind === "OBJECT_TYPE") {
          const t = unwrap(object);
          if (t && t[0] === "TypeName") visitAs("TypeName", t[1], s);
          else s.refuse("This type name cannot be read.");
        } else {
          ownName(object, s, sqlWords(kind).toLowerCase());
        }
      }
    },
  },
  RenameStmt: {
    label: "RENAME",
    fields: {
      renameType: OWN,
      relationType: S,
      relation: inline("RangeVar"),
      object: OWN,
      subname: S,
      newname: OWN,
      behavior: S,
      missing_ok: S,
    },
    check(f, s) {
      const kind = String(f.renameType);
      const relation = RELATION_OBJECTS.has(kind);
      if (!relation && kind !== "OBJECT_COLUMN" && kind !== "OBJECT_TABCONSTRAINT" && kind !== "OBJECT_TYPE") {
        s.refuse(`Renaming a ${sqlWords(kind).toLowerCase()} is not allowed in an app migration.`);
        return;
      }
      if (kind === "OBJECT_TYPE") ownName(f.object, s, "type");
      else if (f.object !== undefined) s.refuse("This RENAME cannot be read.");
      const newname = typeof f.newname === "string" ? f.newname : "";
      if (relation && reserved(newname)) s.refuse(reservedName(newname));
    },
  },
  CommentStmt: {
    label: "COMMENT",
    fields: { objtype: OWN, object: OWN, comment: S },
    check(f, s) {
      const kind = String(f.objtype);
      if (RELATION_OBJECTS.has(kind)) {
        ownName(f.object, s, sqlWords(kind).toLowerCase());
      } else if (kind === "OBJECT_COLUMN" || kind === "OBJECT_TABCONSTRAINT") {
        ownColumnName(f.object, s, sqlWords(kind).toLowerCase());
      } else if (kind === "OBJECT_TYPE") {
        const t = unwrap(f.object);
        if (t && t[0] === "TypeName") visitAs("TypeName", t[1], s);
        else s.refuse("This type name cannot be read.");
      } else {
        s.refuse(`COMMENT ON ${sqlWords(kind)} is not allowed in an app migration.`);
      }
    },
  },
};

/** The statements a migration may consist of. Each also has a rule above. */
const STATEMENTS = new Set([
  "CreateStmt",
  "AlterTableStmt",
  "IndexStmt",
  "ViewStmt",
  "CreateSeqStmt",
  "AlterSeqStmt",
  "CreateEnumStmt",
  "AlterEnumStmt",
  "DropStmt",
  "RenameStmt",
  "CommentStmt",
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "TruncateStmt",
]);

const GRANTS =
  "GRANT and REVOKE are not allowed: an app's tables are reached only through context.db, and the platform manages privileges.";
const ROLES = "Roles are the platform's to manage: an app migration cannot create, change or drop one.";
const SETTINGS =
  "SET, RESET and SHOW are not allowed: a migration runs with settings the platform fixes, its role and search path among them.";
const EXTENSIONS =
  "Extensions are not allowed in app migrations: the platform enables any it needs in its own migrations, and gen_random_uuid() is built in.";
const CODE = "An app migration creates and fills tables. It does not define or run code in the database.";
const POLICIES =
  "Row-level security policies are not allowed: every app table has RLS on with no policies, and the platform keeps it that way.";

/** Why a statement outside STATEMENTS is refused, where a generic line would not say enough. */
const REFUSALS: Record<string, string> = {
  CreateTrigStmt:
    "CREATE TRIGGER is not allowed: a trigger on an app table runs with the platform's database role whenever the platform writes the table. " +
    'To keep a timestamp current on every update, list the column under "updatedAt" in app.json and the platform adds a reviewed trigger for it.',
  RuleStmt: "CREATE RULE is not allowed: a rule rewrites the queries the platform runs against the table.",
  CreateFunctionStmt: `CREATE FUNCTION and CREATE PROCEDURE are not allowed. ${CODE}`,
  AlterFunctionStmt: `ALTER FUNCTION is not allowed. ${CODE}`,
  DoStmt: `DO blocks are not allowed. ${CODE}`,
  CallStmt: `CALL is not allowed. ${CODE}`,
  CreatePolicyStmt: POLICIES,
  AlterPolicyStmt: POLICIES,
  GrantStmt: GRANTS,
  GrantRoleStmt: GRANTS,
  AlterDefaultPrivilegesStmt: GRANTS,
  CreateRoleStmt: ROLES,
  AlterRoleStmt: ROLES,
  AlterRoleSetStmt: ROLES,
  DropRoleStmt: ROLES,
  AlterOwnerStmt: OWNERSHIP,
  ReassignOwnedStmt: OWNERSHIP,
  DropOwnedStmt: OWNERSHIP,
  VariableSetStmt: SETTINGS,
  VariableShowStmt: SETTINGS,
  CreateExtensionStmt: EXTENSIONS,
  AlterExtensionStmt: EXTENSIONS,
  AlterExtensionContentsStmt: EXTENSIONS,
  CreateSchemaStmt: "An app has exactly one schema, which the platform creates for it.",
  AlterObjectSchemaStmt: "SET SCHEMA is not allowed: an app's objects stay in its own schema.",
  TransactionStmt:
    "Transaction control is not allowed: each migration file already runs in a transaction of its own, which commits only if every statement succeeds.",
  CopyStmt: "COPY is not allowed: add rows with INSERT.",
  SelectStmt:
    "A bare SELECT or VALUES is not allowed: a migration changes tables or their rows. Fill a table with INSERT ... SELECT, and move a sequence with ALTER SEQUENCE ... RESTART.",
  CreateTableAsStmt:
    "CREATE TABLE AS, SELECT INTO and materialized views are not supported: create the table, then INSERT ... SELECT into it.",
  CreateDomainStmt: "Domains are not supported in app migrations: put the check on the column.",
};

/** Statements whose node names do not read as their SQL. */
const STATEMENT_NAMES: Record<string, string> = {
  CreateEventTrigStmt: "CREATE EVENT TRIGGER",
  SecLabelStmt: "SECURITY LABEL",
  CompositeTypeStmt: "CREATE TYPE ... AS (...)",
  CreateRangeStmt: "CREATE TYPE ... AS RANGE",
  DefineStmt: "CREATE AGGREGATE, OPERATOR, COLLATION or TEXT SEARCH",
  RefreshMatViewStmt: "REFRESH MATERIALIZED VIEW",
  CreateStatsStmt: "CREATE STATISTICS",
  CheckPointStmt: "CHECKPOINT",
  VacuumStmt: "VACUUM and ANALYZE",
  CreateForeignServerStmt: "CREATE SERVER",
  CreateFdwStmt: "CREATE FOREIGN DATA WRAPPER",
  CreatePLangStmt: "CREATE LANGUAGE",
  CreateOpClassStmt: "CREATE OPERATOR CLASS",
  CreateConversionStmt: "CREATE CONVERSION",
  CreateTransformStmt: "CREATE TRANSFORM",
  CreateAmStmt: "CREATE ACCESS METHOD",
  CreatedbStmt: "CREATE DATABASE",
  CreateTableSpaceStmt: "CREATE TABLESPACE",
};

/** For a node that has no rule: what it is, in words a migration author would recognize. */
const NODE_NAMES: Record<string, string> = {
  ParamRef: "A $n parameter",
  GroupingSet: "GROUPING SETS, ROLLUP and CUBE",
  RangeTableSample: "TABLESAMPLE",
  RangeTableFunc: "XMLTABLE",
  XmlExpr: "An XML expression",
  XmlSerialize: "XMLSERIALIZE",
  CurrentOfExpr: "WHERE CURRENT OF",
};

function visit(node: unknown, s: Scope): void {
  const n = unwrap(node);
  if (!n) {
    s.refuse("Part of this statement cannot be read.");
    return;
  }
  visitAs(n[0], n[1], s);
}

function visitAs(type: string, f: unknown, s: Scope): void {
  if (!isObject(f)) {
    s.refuse("Part of this statement cannot be read.");
    return;
  }
  const here = s.at(f);
  const rule = RULES[type];
  if (!rule) {
    here.refuse(`${NODE_NAMES[type] ?? sqlWords(type)} is not supported in an app migration.`);
    return;
  }
  for (const [key, value] of Object.entries(f)) {
    const kind = rule.fields[key];
    if (kind === undefined) {
      here.refuse(`This ${rule.label} uses "${key}", which app migrations do not support.`);
    } else if (kind === "scalar") {
      if (typeof value === "object" && value !== null) here.refuse(`This ${rule.label} cannot be read.`);
    } else if (kind === "node") {
      visit(value, here);
    } else if (kind === "nodes") {
      if (!Array.isArray(value)) here.refuse(`This ${rule.label} cannot be read.`);
      else for (const item of value) visit(item, here);
    } else if (kind !== "own") {
      visitAs(kind.inline, value, here);
    }
  }
  rule.check?.(f, here);
}

// ── checking a file ─────────────────────────────────────────────────────────

/** Byte offsets of each newline in `bytes`, to turn a byte offset into a line. */
function newlineOffsets(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) out.push(i);
  return out;
}

function lineAtByte(newlines: readonly number[], offset: number): number {
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlines[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** The 1-based line holding the character at 0-based `index`, counting characters as Postgres does. */
export function lineAtCharacter(text: string, index: number): number {
  const before = Array.from(text).slice(0, Math.max(0, index)).join("");
  return before.split("\n").length;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("--")) ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

/**
 * Every reason `sqlText`, one migration file of the app whose schema is
 * `appSchema`, may not run. Empty when it may.
 *
 * Parse locations are byte offsets into the UTF-8 text, which is why the file
 * is measured as bytes: one em dash in a comment would otherwise put every
 * later line number off.
 */
export async function checkAppMigrationSql(sqlText: string, appSchema: string): Promise<SqlProblem[]> {
  const { parseSync } = await loadParser();
  const bytes = Buffer.from(sqlText, "utf8");
  const newlines = newlineOffsets(bytes);

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(sqlText);
  } catch (err) {
    const details = (err as { sqlDetails?: { cursorPosition?: number } }).sqlDetails;
    const position = details?.cursorPosition;
    const line = typeof position === "number" && position >= 0 ? lineAtCharacter(sqlText, position) : 1;
    return [
      {
        line,
        statement: firstLine(sqlText.split("\n").slice(line - 1).join("\n")),
        reason: `This does not parse as SQL: ${err instanceof Error ? err.message : String(err)}.`,
      },
    ];
  }

  const problems: SqlProblem[] = [];
  for (const raw of parsed.stmts ?? []) {
    const start = raw.stmt_location ?? 0;
    const end = raw.stmt_len ? start + raw.stmt_len : bytes.length;
    const statement = firstLine(bytes.subarray(start, end).toString("utf8"));
    const seen = new Set<string>();
    const scope = new Scope(
      appSchema,
      (offset, reason) => {
        const line = lineAtByte(newlines, offset);
        const key = `${line}\u0000${reason}`;
        if (seen.has(key)) return;
        seen.add(key);
        problems.push({ line, statement, reason });
      },
      start,
      null,
    );

    const n = unwrap(raw.stmt);
    if (!n) {
      scope.refuse("This statement cannot be read.");
    } else if (!STATEMENTS.has(n[0])) {
      scope
        .at(n[1])
        .refuse(REFUSALS[n[0]] ?? `${STATEMENT_NAMES[n[0]] ?? sqlWords(n[0])} is not allowed in an app migration.`);
    } else {
      visitAs(n[0], n[1], scope);
    }
  }
  return problems;
}

/** Problems as the build and the release step print them: `apps/x/migrations/001.sql:12: reason`. */
export function formatSqlProblems(file: string, problems: readonly SqlProblem[]): string {
  return problems
    .map((p) => `${file}:${p.line}: ${p.reason}${p.statement ? `\n    in: ${p.statement}` : ""}`)
    .join("\n");
}

// ── what the migrations build ───────────────────────────────────────────────

/**
 * The tables an app's migrations leave behind, with each one's columns and the
 * name of each column's type (`timestamptz`, `text`), from applying the files'
 * CREATE TABLE, ALTER TABLE, RENAME and DROP statements in order.
 *
 * For checks the build makes against the manifest, such as that an `updatedAt`
 * column exists. It reads what the files say; the release step checks the
 * database itself. Files that do not parse are skipped: checkAppMigrationSql
 * reports them.
 */
export async function describeAppTables(
  sqlTexts: readonly string[],
  appSchema: string,
): Promise<Map<string, Map<string, string>>> {
  const { parseSync } = await loadParser();
  const tables = new Map<string, Map<string, string>>();

  const tableName = (rel: unknown): string | null => {
    if (!isObject(rel) || typeof rel.relname !== "string") return null;
    if (rel.schemaname !== undefined && rel.schemaname !== appSchema) return null;
    return rel.relname;
  };
  const typeOf = (def: Json): string => {
    const parts = isObject(def.typeName) ? nameParts(def.typeName.names) : null;
    return parts?.[parts.length - 1] ?? "";
  };
  const columnOf = (def: unknown): [string, string] | null => {
    const n = unwrap(def);
    if (!n || n[0] !== "ColumnDef" || typeof n[1].colname !== "string") return null;
    return [n[1].colname, typeOf(n[1])];
  };

  for (const text of sqlTexts) {
    let parsed: ReturnType<typeof parseSync>;
    try {
      parsed = parseSync(text);
    } catch {
      continue;
    }
    for (const raw of parsed.stmts ?? []) {
      const n = unwrap(raw.stmt);
      if (!n) continue;
      const [type, f] = n;

      if (type === "CreateStmt") {
        const name = tableName(f.relation);
        if (!name || (f.if_not_exists && tables.has(name))) continue;
        const columns = new Map<string, string>();
        for (const element of asList(f.tableElts)) {
          const column = columnOf(element);
          if (column) columns.set(column[0], column[1]);
        }
        tables.set(name, columns);
      } else if (type === "AlterTableStmt" && f.objtype === "OBJECT_TABLE") {
        const columns = tables.get(tableName(f.relation) ?? "");
        if (!columns) continue;
        for (const item of asList(f.cmds)) {
          const cmd = unwrap(item)?.[1];
          if (!cmd) continue;
          if (cmd.subtype === "AT_AddColumn") {
            const column = columnOf(cmd.def);
            if (column && !columns.has(column[0])) columns.set(column[0], column[1]);
          } else if (cmd.subtype === "AT_DropColumn" && typeof cmd.name === "string") {
            columns.delete(cmd.name);
          } else if (cmd.subtype === "AT_AlterColumnType" && typeof cmd.name === "string") {
            // The new type, on a ColumnDef that names no column: the command does.
            const def = unwrap(cmd.def);
            if (def && def[0] === "ColumnDef" && columns.has(cmd.name)) columns.set(cmd.name, typeOf(def[1]));
          }
        }
      } else if (type === "RenameStmt") {
        const name = tableName(f.relation);
        const columns = name ? tables.get(name) : undefined;
        if (!name || !columns || typeof f.newname !== "string") continue;
        if (f.renameType === "OBJECT_TABLE") {
          tables.delete(name);
          tables.set(f.newname, columns);
        } else if (f.renameType === "OBJECT_COLUMN" && typeof f.subname === "string" && columns.has(f.subname)) {
          columns.set(f.newname, columns.get(f.subname)!);
          columns.delete(f.subname);
        }
      } else if (type === "DropStmt" && f.removeType === "OBJECT_TABLE") {
        for (const object of asList(f.objects)) {
          const parts = nameParts(object);
          if (parts && (parts.length === 1 || parts[0] === appSchema)) tables.delete(parts[parts.length - 1]);
        }
      }
    }
  }
  return tables;
}
