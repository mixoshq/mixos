/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writes the app import allowlist into docs/apps/architecture.md, between its
 * app-imports markers, from src/lib/apps/import-policy.mjs.
 *
 * The list is code because the build and the editor both enforce it. A
 * hand-written copy would drift the first time an entry changed, and an author
 * trusts the docs table over the code. So the table is generated, and
 * src/lib/apps/import-policy.test.ts fails when the two differ.
 *
 * Run: npx tsx scripts/generate-import-docs.ts
 */
import fs from "fs";
import path from "path";
import { renderAllowlist } from "../src/lib/apps/import-policy.mjs";

const DOC = path.resolve(__dirname, "../docs/apps/architecture.md");
const BEGIN =
  "<!-- BEGIN app-imports: generated from src/lib/apps/import-policy.mjs by scripts/generate-import-docs.ts. Do not edit by hand. -->";
const END = "<!-- END app-imports -->";

const doc = fs.readFileSync(DOC, "utf8");
const start = doc.indexOf("<!-- BEGIN app-imports");
const end = doc.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  throw new Error(`${DOC} has no app-imports markers to write between.`);
}

fs.writeFileSync(DOC, `${doc.slice(0, start)}${BEGIN}\n${renderAllowlist()}\n${doc.slice(end)}`);
console.log(`Wrote the app import allowlist into ${path.relative(process.cwd(), DOC)}`);
