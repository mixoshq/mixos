/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prove a connector's `auth.scopesUrl` actually parses, and show what it yields.
 *
 *   npx tsx scripts/check-scopes.ts gmail
 *
 * An AUTHORING step, deliberately not a build step. The registry reads that
 * page at an admin's request and caches the result, so a wrong URL is not a
 * broken build — it is an empty Permissions list nobody notices for a week.
 * This catches it while the author is still holding the manifest. Putting it in
 * the build instead would make `npm run build` fail whenever a third party has
 * a bad afternoon.
 *
 * Read the output. "14 scopes parsed" is not the test; the test is whether the
 * descriptions are English sentences and the read/write split looks right.
 */
import { connectorRegistry } from "../src/generated/connector-registry";
import { fetchScopeDocs } from "../src/lib/connectors/scope-docs";

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: npx tsx scripts/check-scopes.ts <connector-name>");
    process.exit(1);
  }

  const connector = connectorRegistry.find((c) => c.name === name);
  if (!connector) {
    console.error(
      `No connector named "${name}". Known: ${connectorRegistry.map((c) => c.name).join(", ") || "(none)"}`,
    );
    process.exit(1);
  }

  const url = connector.auth?.scopesUrl;
  if (!url) {
    console.error(`connectors/${name}/connector.json declares no auth.scopesUrl.`);
    process.exit(1);
  }

  console.log(`Reading ${url}\n`);
  let scopes;
  try {
    scopes = await fetchScopeDocs(url);
  } catch (err) {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      "\nA page that tabulates scopes against descriptions is what this needs — " +
        "not an API overview or a quickstart.",
    );
    process.exit(1);
  }

  const requested = new Set(connector.auth?.scopes ?? []);
  for (const s of scopes) {
    const mark = requested.has(s.scope) ? "*" : " ";
    console.log(
      `${mark} ${s.access.padEnd(11)} ${s.scope.replace(/\/$/, "").split("/").pop()!.slice(0, 34).padEnd(36)} ${s.description.slice(0, 60)}`,
    );
  }

  const count = (a: string) => scopes.filter((s) => s.access === a).length;
  console.log(
    `\n${scopes.length} scopes parsed — ${count("read")} read, ${count("write")} write, ` +
      `${count("read-write")} read+write.`,
  );
  console.log(`${requested.size} requested by this connector, marked *.`);

  // A scope this connector asks for that the page never documents is usually a
  // typo in `auth.scopes`, and it would render as an unexplained row.
  const undocumented = [...requested].filter(
    (r) => !scopes.some((s) => s.scope === r),
  );
  if (undocumented.length > 0) {
    console.log(
      `\nWARNING: requested but not found on that page:\n` +
        undocumented.map((u) => `  - ${u}`).join("\n") +
        `\n  Check auth.scopes for a typo, or point scopesUrl at the page that documents them.`,
    );
  }
}

void main();
