/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appIdentifierProblems,
  appRoleName,
  appSchemaName,
  appSlugProblem,
  decodeAppSlug,
  encodeAppSlug,
  reservedAppSlugProblem,
} from "./app-identifiers";

test("a slug's schema and role", () => {
  assert.equal(appSchemaName("sales-tracker"), "app_sales_tracker");
  assert.equal(appRoleName("sales-tracker"), "mixos_app_sales_tracker");
  assert.equal(appSchemaName("my_app"), "app_my__app");
  assert.equal(appSchemaName("crm"), "app_crm");
  assert.equal(appSchemaName("2fa"), "app_2fa");
});

test("the pairs the table prefix merged get names of their own", () => {
  // `_app_<slug>_` + table: my-app/my_app collided on every table, and
  // crm + reports_deals was the same table as crm-reports + deals.
  assert.notEqual(appSchemaName("my-app"), appSchemaName("my_app"));
  assert.notEqual(appSchemaName("crm"), appSchemaName("crm-reports"));
  assert.notEqual(appSchemaName("crm-reports"), appSchemaName("crm_reports"));
  assert.deepEqual(appIdentifierProblems(["crm", "crm-reports", "crm_reports", "my-app", "my_app"]), []);
});

test("the encoding reads back to the slug it came from, and to nothing else", () => {
  const words = ["a", "b2", "crm", "x"];
  const slugs = new Set<string>();
  for (const a of words) {
    slugs.add(a);
    for (const sep of ["-", "_"]) {
      for (const b of words) {
        slugs.add(`${a}${sep}${b}`);
        for (const sep2 of ["-", "_"]) for (const c of words) slugs.add(`${a}${sep}${b}${sep2}${c}`);
      }
    }
  }

  const seen = new Map<string, string>();
  for (const slug of slugs) {
    const encoded = encodeAppSlug(slug);
    assert.match(encoded, /^[a-z0-9_]+$/, "an unquoted Postgres name");
    assert.equal(decodeAppSlug(encoded), slug);
    assert.equal(seen.get(encoded), undefined, `${slug} and ${seen.get(encoded)} share ${encoded}`);
    seen.set(encoded, slug);
  }

  for (const notEncoded of ["", "_a", "a_", "a___b", "a____b", "A"]) {
    assert.equal(decodeAppSlug(notEncoded), null, notEncoded);
  }
});

test("slugs a schema name cannot carry unambiguously are refused", () => {
  for (const bad of ["", "My-App", "my app", "-x", "x-", "_x", "x_", "a--b", "a__b", "a-_b", "a.b", "a/b", "ä"]) {
    assert.ok(appSlugProblem(bad), `accepted ${JSON.stringify(bad)}`);
    assert.throws(() => appSchemaName(bad));
  }
  assert.equal(appSlugProblem("wall-e"), null);
});

test("a slug whose role name Postgres would cut short is refused", () => {
  // mixos_app_ is 10 characters, so 53 is the most an encoded slug can be.
  assert.equal(appSlugProblem("a".repeat(53)), null);
  assert.equal(appRoleName("a".repeat(53)).length, 63);
  assert.match(appSlugProblem("a".repeat(54)) ?? "", /too long/);
  // An underscore costs two characters once encoded.
  assert.match(appSlugProblem(`${"a".repeat(26)}_${"b".repeat(26)}`) ?? "", /too long/);
});

test("the overlap check fails an encoding that merges two apps", () => {
  // The rule the table prefix used: hyphens to underscores, nothing escaped.
  const prefixStyle = (slug: string) => {
    const flat = slug.replace(/-/g, "_");
    return { schema: `app_${flat}`, role: `mixos_app_${flat}` };
  };
  const problems = appIdentifierProblems(["my-app", "my_app", "crm"], prefixStyle);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /apps\/my-app and apps\/my_app would share the database schema app_my_app/);
  assert.match(problems[1], /would share the database role mixos_app_my_app/);
});

test("the overlap check reports invalid slugs, and does not count an app twice", () => {
  assert.deepEqual(appIdentifierProblems(["notes", "notes"]), []);
  const [problem] = appIdentifierProblems(["Notes"]);
  assert.match(problem, /^apps\/Notes: "Notes" is not a valid app slug/);
});

test("a slug whose URL a platform page has is reserved, and only that slug", () => {
  assert.match(reservedAppSlugProblem("release-notes") ?? "", /"release-notes" is reserved: \/apps\/release-notes/);
  for (const free of ["release-notes-2", "release_notes", "notes", "wall-e"]) {
    assert.equal(reservedAppSlugProblem(free), null, free);
  }
  // Reserved is not invalid: the schema encoding still holds for it.
  assert.equal(appSlugProblem("release-notes"), null);
});
