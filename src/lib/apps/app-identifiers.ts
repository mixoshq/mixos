/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where an app's data lives in Postgres: one schema, `app_<slug>`, owned by one
 * role, `mixos_app_<slug>`, which the app's migrations run as.
 *
 * ONE ENCODING, USED EVERYWHERE. The release step that creates the role and the
 * schema (scripts/app-migrations.ts), the client that reads them
 * (./scoped-db.ts), the admin database viewer (./admin-actions.ts) and the build
 * check that no two apps share them (scripts/generate-project-registry.ts) all
 * call this module, so none of them spells the encoding out by hand.
 *
 * WHY IT HAS TO BE ONE-TO-ONE. A slug may contain `-`, which an unquoted
 * Postgres name cannot. Turning `-` into `_` alone would send `my-app` and
 * `my_app` to the same name, and two apps that share a schema share every
 * table in it. Here `-` becomes `_` and `_` becomes `__`. A slug may not start
 * or end with a separator or put two side by side, so every run of underscores
 * in an encoded name is one or two long and reads back to exactly one slug.
 *
 * No server-only imports: the registry generator and the release step load this
 * from scripts/, outside Next.
 */

/** Lowercase letters and digits, in words joined by single hyphens or underscores. */
export const APP_SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const SCHEMA_PREFIX = "app_";
const ROLE_PREFIX = "mixos_app_";

/**
 * NAMEDATALEN - 1. Postgres cuts a longer name short without an error, and two
 * long slugs cut to the same name would share a schema.
 */
const MAX_IDENTIFIER = 63;

/** The longest encoded slug that still fits behind the longer of the two prefixes. */
const MAX_ENCODED = MAX_IDENTIFIER - ROLE_PREFIX.length;

/** Why `slug` cannot name an app with a database, or null when it can. */
export function appSlugProblem(slug: string): string | null {
  if (!APP_SLUG_PATTERN.test(slug)) {
    return (
      `"${slug}" is not a valid app slug. Use lowercase letters and digits, in words ` +
      `joined by single hyphens or underscores (for example "sales-tracker").`
    );
  }
  if (encode(slug).length > MAX_ENCODED) {
    return (
      `"${slug}" is too long: its database role, ${ROLE_PREFIX}${encode(slug)}, would be ` +
      `longer than Postgres's ${MAX_IDENTIFIER}-character limit.`
    );
  }
  return null;
}

function encode(slug: string): string {
  return slug.replace(/_/g, "__").replace(/-/g, "_");
}

/** The slug, as it appears inside the app's schema and role names. Throws on an invalid slug. */
export function encodeAppSlug(slug: string): string {
  const problem = appSlugProblem(slug);
  if (problem) throw new Error(problem);
  return encode(slug);
}

/** The slug an encoded name came from, or null when no valid slug encodes to it. */
export function decodeAppSlug(encoded: string): string | null {
  let invalid = false;
  const slug = encoded.replace(/_+/g, (run) => {
    if (run.length === 1) return "-";
    if (run.length === 2) return "_";
    invalid = true;
    return run;
  });
  if (invalid || appSlugProblem(slug) !== null || encode(slug) !== encoded) return null;
  return slug;
}

/** The schema that holds the app's tables: `app_<slug>`. */
export function appSchemaName(slug: string): string {
  return `${SCHEMA_PREFIX}${encodeAppSlug(slug)}`;
}

/** The role that owns that schema, and that the app's migrations run as: `mixos_app_<slug>`. */
export function appRoleName(slug: string): string {
  return `${ROLE_PREFIX}${encodeAppSlug(slug)}`;
}

/** The names one app's data lives under. */
export interface AppDatabaseNames {
  schema: string;
  role: string;
}

function databaseNames(slug: string): AppDatabaseNames {
  return { schema: appSchemaName(slug), role: appRoleName(slug) };
}

/**
 * Every reason these apps cannot each have a schema and a role of their own:
 * an invalid or overlong slug, or two slugs that come out as the same name.
 *
 * With valid slugs this module's encoding cannot produce the last one. The
 * check is here anyway, and takes the naming as a parameter so a test can run
 * it against another encoding: a change that broke the encoding should fail the
 * build, not merge two apps' data.
 */
export function appIdentifierProblems(
  slugs: readonly string[],
  namesFor: (slug: string) => AppDatabaseNames = databaseNames,
): string[] {
  const problems: string[] = [];
  const taken = { schema: new Map<string, string>(), role: new Map<string, string>() };

  for (const slug of new Set(slugs)) {
    const problem = appSlugProblem(slug);
    if (problem) {
      problems.push(`apps/${slug}: ${problem}`);
      continue;
    }
    const names = namesFor(slug);
    for (const kind of ["schema", "role"] as const) {
      const other = taken[kind].get(names[kind]);
      if (other !== undefined) {
        problems.push(
          `apps/${other} and apps/${slug} would share the database ${kind} ${names[kind]}.`,
        );
      } else {
        taken[kind].set(names[kind], slug);
      }
    }
  }
  return problems;
}
