/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What an app's entries ask of a connector, whether a version gives it, and
 * what the contract refuses between two versions of a connector.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareDeclaredMethods,
  connectorEntryNames,
  connectorRequirements,
  connectorSurfaceOf,
  contractProblems,
  describeConnectorVersion,
  describeRequirement,
  parseConnectorVersion,
  satisfiesConnectorVersion,
} from "./requirements";

test("a version is three numbers and nothing else", () => {
  assert.deepEqual(parseConnectorVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseConnectorVersion("0.0.0"), { major: 0, minor: 0, patch: 0 });
  for (const bad of ["v1.2.3", "1.2", "1", "1.2.3-beta.1", "1.2.3+abc", "^1.2.3", "01.2.3", " 1.2.3", ""]) {
    assert.equal(parseConnectorVersion(bad), null, bad);
  }
});

test("a later release of the same major version satisfies an app, and nothing else does", () => {
  assert.equal(satisfiesConnectorVersion("1.2.0", "1.2.0"), true);
  assert.equal(satisfiesConnectorVersion("1.2.0", "1.2.7"), true);
  assert.equal(satisfiesConnectorVersion("1.2.0", "1.10.0"), true);
  assert.equal(satisfiesConnectorVersion("1.2.0", "1.1.9"), false);
  assert.equal(satisfiesConnectorVersion("1.2.0", "2.0.0"), false);
  assert.equal(satisfiesConnectorVersion("2.0.0", "1.9.9"), false);
  // Major version 0 is a major version like any other.
  assert.equal(satisfiesConnectorVersion("0.2.0", "0.5.1"), true);
  assert.equal(satisfiesConnectorVersion("0.2.0", "1.0.0"), false);
  // Not a version on either side is not a match.
  assert.equal(satisfiesConnectorVersion("1.2", "1.2.0"), false);
  assert.equal(satisfiesConnectorVersion("1.2.0", "latest"), false);
  assert.equal(describeConnectorVersion("1.2.0"), "1.2.0 or a later 1.x release");
});

test("entries read as requirements, required first, tolerating what isn't one", () => {
  const needs = connectorRequirements(
    [{ name: "crm", version: "1.2.0", access: "write" }, "bare", { name: "no-version" }, null],
    [{ name: "slack", version: "2.0.0" }],
  );
  assert.deepEqual(needs, [
    { name: "crm", optional: false, access: "write", version: "1.2.0" },
    { name: "slack", optional: true, access: "read", version: "2.0.0" },
  ]);
  assert.deepEqual(connectorEntryNames([{ name: "crm", version: "1.0.0" }, "bare", { version: "1.0.0" }, 7]), ["crm"]);
  assert.deepEqual(connectorEntryNames(undefined), []);
  assert.deepEqual(needs.map(describeRequirement), [
    "crm 1.2.0 or later, changes data",
    "slack 2.0.0 or later, optional",
  ]);
});

test("method changes are added, removed, and reads made into writes", () => {
  assert.deepEqual(
    compareDeclaredMethods(
      [{ method: "a" }, { method: "b" }, { method: "c", mutates: true }],
      [{ method: "a", mutates: true }, { method: "c", mutates: true }, { method: "d" }],
    ),
    { added: ["d"], removed: ["b"], madeWrites: ["a"] },
  );
});

const surface = (version: string, ...methods: (string | [string, boolean])[]) => ({
  version,
  telemetry: methods.map((m) => (typeof m === "string" ? { method: m } : { method: m[0], mutates: m[1] })),
});

test("within a major version a connector only adds", () => {
  // Adding, at any version that doesn't go backwards, is fine between commits.
  assert.deepEqual(contractProblems(surface("1.0.0", "a"), surface("1.0.0", "a", "b")), []);
  assert.deepEqual(contractProblems(surface("1.0.0", "a"), surface("1.1.0", "a", "b")), []);

  const [removed] = contractProblems(surface("1.4.0", "a", "b"), surface("1.5.0", "a"));
  assert.match(removed, /^it removes `b`, which an app built against 1\.4\.0 may rely on, so it needs a new major version: 2\.0\.0, not 1\.5\.0\.$/);
  assert.deepEqual(contractProblems(surface("1.4.0", "a", "b"), surface("2.0.0", "a")), []);

  const [madeWrite] = contractProblems(surface("1.0.0", "a"), surface("1.1.0", ["a", true]));
  assert.match(madeWrite, /declares `a` `mutates`, which was a read/);

  const [backwards] = contractProblems(surface("1.2.0", "a"), surface("1.1.0", "a"));
  assert.equal(backwards, "its version went backwards, from 1.2.0 to 1.1.0.");
});

test("a release needs a higher version, and an addition at least a new minor one", () => {
  const release = { release: true };
  assert.match(contractProblems(surface("1.2.0", "a"), surface("1.2.0", "a"), release)[0], /still 1\.2\.0: a new release needs a higher one/);
  assert.match(
    contractProblems(surface("1.2.0", "a"), surface("1.2.1", "a", "b"), release)[0],
    /^it adds `b`, so it needs at least a new minor version, 1\.3\.0, for an app that needs it to name\.$/,
  );
  assert.deepEqual(contractProblems(surface("1.2.0", "a"), surface("1.2.1", "a"), release), []);
  assert.deepEqual(contractProblems(surface("1.2.0", "a"), surface("1.3.0", "a", "b"), release), []);
  assert.deepEqual(contractProblems(surface("1.2.0", "a", "b"), surface("2.0.0", "c"), release), []);
});

test("a manifest's text reads as the surface the contract compares", () => {
  assert.deepEqual(
    connectorSurfaceOf(JSON.stringify({ version: "1.0.0", telemetry: [{ method: "a", mutates: true }, { nope: 1 }] })),
    { version: "1.0.0", telemetry: [{ method: "a", mutates: true }] },
  );
  assert.deepEqual(connectorSurfaceOf(JSON.stringify({ name: "x" })), { version: undefined, telemetry: undefined });
  assert.equal(connectorSurfaceOf("not json"), null);
  assert.equal(connectorSurfaceOf(null), null);
  // Without both versions there is nothing to hold a change to: the schema reports it.
  assert.deepEqual(contractProblems({ version: undefined, telemetry: [] }, surface("1.0.0")), []);
});
