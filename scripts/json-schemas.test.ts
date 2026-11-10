/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/json-schemas.ts and the `$schema` URLs: the JSON Schemas committed in
 * docs/schemas/ are the ones the Zod schemas make, each requires its own URL,
 * and a release fills in the release that first reads them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_FILE_NAMES, parseSchemaUrl, schemaProblem, schemaUrl } from "../src/lib/extensions/schema-urls";
import { buildIndex, buildSchema, staleFiles } from "./json-schemas";
import { UNRELEASED, stampSchemaSince } from "./release-prep";

describe("the committed schemas", () => {
  test("are what the Zod schemas make", () => {
    assert.deepEqual(staleFiles(), [], "run `npx tsx scripts/json-schemas.ts` and commit docs/schemas/");
  });

  test("each requires `$schema`, fixed to its own URL", () => {
    for (const file of SCHEMA_FILE_NAMES) {
      const schema = buildSchema(file) as {
        $id: string;
        required: string[];
        properties: { $schema: { const: string } };
        additionalProperties: unknown;
      };
      assert.equal(schema.$id, schemaUrl(file));
      assert.equal(schema.properties.$schema.const, schemaUrl(file));
      assert.ok(schema.required.includes("$schema"), file);
      assert.equal(schema.additionalProperties, false, `${file} refuses keys it doesn't name, as MixOS does`);
    }
  });

  test("release notes are an object, so there is somewhere to put `$schema`", () => {
    const schema = buildSchema("release-notes") as { type: string; required: string[] };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["$schema", "notes"]);
  });
});

describe("schema URLs", () => {
  test("read back to the file and version they name", () => {
    for (const file of SCHEMA_FILE_NAMES) {
      assert.deepEqual(parseSchemaUrl(schemaUrl(file, 3)), { file, version: 3 });
    }
  });

  test("a file is read at exactly the version this MixOS writes, and anything else says what to do", () => {
    const where = "apps/x/app.json";
    assert.equal(schemaProblem("app", schemaUrl("app"), where), null);
    assert.match(schemaProblem("app", undefined, where)!, /has no "\$schema".*Add "\$schema": "https:\/\/mixos\.org\/schemas\/app\/v1\.json" as its first key/);
    assert.match(schemaProblem("app", 1, where)!, /"\$schema" is a URL, as a string/);
    assert.match(schemaProblem("app", "https://example.com/app.json", where)!, /isn't one of MixOS's schemas/);
    assert.match(schemaProblem("app", schemaUrl("theme"), where)!, /is the schema of theme\.json, not of app\.json/);
    assert.match(schemaProblem("app", schemaUrl("app", 2), where)!, /version 2 of app\.json, and this MixOS reads version 1\. It needs a newer MixOS/);
  });

  test("anything that isn't one of MixOS's is null", () => {
    for (const url of [
      "https://mixos.org/schemas/app/v0.json",
      "https://mixos.org/schemas/app/v1",
      "https://mixos.org/schemas/widget/v1.json",
      "http://mixos.org/schemas/app/v1.json",
      "https://example.com/schemas/app/v1.json",
      "https://mixos.org/schemas/app/v1.json?x",
      "https://mixos.org/schemas/toString/v1.json",
    ]) {
      assert.equal(parseSchemaUrl(url), null, url);
    }
  });
});

describe("the index", () => {
  test("lists each schema as unreleased until a release says otherwise", () => {
    const index = buildIndex(null);
    assert.deepEqual(
      index.schemas.map((e) => e.file).sort(),
      [...SCHEMA_FILE_NAMES].sort(),
    );
    assert.ok(index.schemas.every((e) => e.since === UNRELEASED));
  });

  test("keeps the release a schema arrived in, and every version it has published", () => {
    const old = { file: "app" as const, describes: "app.json", version: 0, url: "https://mixos.org/schemas/app/v0.json", since: "0.1.0" };
    const previous = buildIndex(null);
    previous.schemas = [old, ...previous.schemas.map((e) => (e.file === "theme" ? { ...e, since: "0.7.0" } : e))];
    const next = buildIndex(previous);
    assert.ok(next.schemas.some((e) => e.url === old.url && e.since === "0.1.0"));
    assert.equal(next.schemas.find((e) => e.file === "theme")!.since, "0.7.0");
    assert.equal(next.schemas.find((e) => e.file === "app" && e.version === 1)!.since, UNRELEASED);
  });

  test("a release fills in every unreleased schema, and nothing else", () => {
    const previous = buildIndex(null);
    previous.schemas = previous.schemas.map((e) => (e.file === "theme" ? { ...e, since: "0.6.0" } : e));
    const text = `${JSON.stringify(previous, null, 2)}\n`;
    const stamped = JSON.parse(stampSchemaSince(text, "0.7.0")) as typeof previous;
    assert.equal(stamped.schemas.find((e) => e.file === "theme")!.since, "0.6.0");
    assert.ok(stamped.schemas.filter((e) => e.file !== "theme").every((e) => e.since === "0.7.0"));
    // Nothing unreleased: the text comes back as it was, so the release PR doesn't list the file.
    assert.equal(stampSchemaSince(stampSchemaSince(text, "0.7.0"), "0.8.0"), stampSchemaSince(text, "0.7.0"));
  });
});
