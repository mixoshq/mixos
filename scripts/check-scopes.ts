/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read a connector's `auth.scopesUrl` and report — or write — its scope catalogue.
 *
 *   npx tsx scripts/check-scopes.ts <connector>            # report only
 *   npx tsx scripts/check-scopes.ts <connector> --write    # rewrite auth.scopes
 *
 * This is the ONLY way `auth.scopes` changes. The registry never fetches that
 * page: the catalogue is committed to `connector.json`, so it is reviewable in
 * a diff, identical across installs, and cannot degrade because a third party
 * had a bad afternoon. The cost is that a provider adding a scope needs a
 * developer to run this and ship the result — which is the trade, deliberately.
 *
 * `--write` PRESERVES the `requested` flags already in the manifest. A refresh
 * must never change what a connector asks for; it only refreshes the catalogue
 * those flags are attached to. Adding a scope to the request is a hand edit,
 * because it is a security decision (invariant 17: minimum scopes only).
 *
 * Read the output. "14 scopes parsed" is not the test; the test is whether the
 * descriptions are English sentences and the read/write split looks right.
 */
import fs from "node:fs";
import path from "node:path";
import { fetchScopeDocs } from "../src/lib/connectors/scope-docs";
import type { DocumentedScope } from "../src/lib/connectors/scope-docs";

interface ManifestScope {
  scope: string;
  description?: string;
  access?: string;
  /** `true` always, `"write"` once an admin allows changes, `false` never. */
  requested: boolean | "write";
  /** The scopes the provider grants as part of this one. A hand edit. */
  includes?: string[];
}

/**
 * Merge a fresh parse over the manifest's existing entries.
 *
 * Every documented scope survives; `requested` comes from the old entry when it
 * had one, `"write"` included, and defaults to false otherwise. A requested
 * scope the page no longer documents is KEPT, as it was, rather than dropped —
 * silently un-requesting a scope the connector actually needs would break
 * authorization at the next reconnect, and a provider reorganising their docs
 * is not consent to change what we ask for.
 *
 * `includes` is kept too, since the parse never finds it. A name in it that the
 * merged catalogue no longer has is dropped, because the build refuses one, and
 * reported in `droppedIncludes` as "<scope> includes <name>".
 */
export function merge(
  existing: ManifestScope[],
  parsed: DocumentedScope[],
): { scopes: ManifestScope[]; orphans: string[]; droppedIncludes: string[] } {
  const old = new Map(existing.map((e) => [e.scope, e]));
  const documented = new Set(parsed.map((p) => p.scope));

  const scopes: ManifestScope[] = parsed.map((p) => ({
    scope: p.scope,
    description: p.description,
    access: p.access,
    requested: old.get(p.scope)?.requested ?? false,
  }));

  const orphaned = existing.filter((e) => e.requested !== false && !documented.has(e.scope));
  for (const e of orphaned) {
    scopes.push({ scope: e.scope, requested: e.requested });
  }
  const orphans = orphaned.map((e) => e.scope);

  const kept = new Set(scopes.map((s) => s.scope));
  const droppedIncludes: string[] = [];
  for (const s of scopes) {
    const includes = old.get(s.scope)?.includes;
    if (includes === undefined) continue;
    const surviving = includes.filter((name) => kept.has(name));
    for (const name of includes) {
      if (!kept.has(name)) droppedIncludes.push(`${s.scope} includes ${name}`);
    }
    if (surviving.length > 0) s.includes = surviving;
  }

  return { scopes, orphans, droppedIncludes };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const name = args.find((a) => !a.startsWith("--"));

  if (!name) {
    console.error(
      "Usage: npx tsx scripts/check-scopes.ts <connector-name> [--write]",
    );
    process.exit(1);
  }

  // Loaded here rather than imported, so merge() can be tested without a
  // generated registry.
  const { connectorRegistry } = await import("../src/generated/connector-registry");
  const connector = connectorRegistry.find((c) => c.name === name);
  if (!connector) {
    console.error(
      `No connector named "${name}". Known: ${connectorRegistry.map((c) => c.name).join(", ") || "(none)"}`,
    );
    process.exit(1);
  }

  const url = connector.auth?.scopesUrl;
  if (!url) {
    console.error(
      `connectors/${name}/connector.json declares no auth.scopesUrl.`,
    );
    process.exit(1);
  }

  console.log(`Reading ${url}\n`);
  let parsed: DocumentedScope[];
  try {
    parsed = await fetchScopeDocs(url);
  } catch (err) {
    console.error(
      `FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "\nA page that tabulates scopes against descriptions is what this needs — " +
        "not an API overview or a quickstart.",
    );
    process.exit(1);
  }

  const existing = (connector.auth?.scopes ?? []) as ManifestScope[];
  const { scopes, orphans, droppedIncludes } = merge(existing, parsed);
  const requestedCount = scopes.filter((s) => s.requested === true).length;
  const writeCount = scopes.filter((s) => s.requested === "write").length;

  for (const s of scopes) {
    const mark = s.requested === true ? "*" : s.requested === "write" ? "w" : " ";
    const short = s.scope.replace(/\/$/, "").split("/").pop()!;
    console.log(
      `${mark} ${(s.access ?? "?").padEnd(11)} ${short.slice(0, 34).padEnd(36)} ${(s.description ?? "").slice(0, 60)}`,
    );
  }

  const count = (a: string) => scopes.filter((s) => s.access === a).length;
  console.log(
    `\n${parsed.length} scopes parsed — ${count("read")} read, ${count("write")} write, ` +
      `${count("read-write")} read+write.`,
  );
  console.log(
    `${requestedCount} requested by this connector, marked *; ` +
      `${writeCount} requested once an admin allows changes, marked w.`,
  );

  if (orphans.length > 0) {
    console.log(
      `\nWARNING: requested but not found on that page:\n` +
        orphans.map((u) => `  - ${u}`).join("\n") +
        `\n  Kept as-is. Check auth.scopes for a typo, or point scopesUrl at the` +
        `\n  page that documents them.`,
    );
  }

  if (droppedIncludes.length > 0) {
    console.log(
      `\nWARNING: includes a scope that page no longer documents:\n` +
        droppedIncludes.map((d) => `  - ${d}`).join("\n") +
        `\n  Dropped from includes. Check the provider's docs for what replaced it.`,
    );
  }

  if (!write) {
    console.log(`\nReport only. Re-run with --write to update connector.json.`);
    return;
  }

  // Rewrite in place. Read the file rather than the registry so comments,
  // key order and formatting elsewhere in the manifest survive untouched.
  const file = path.join(process.cwd(), "connectors", name, "connector.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.auth.scopes = scopes;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

  const added = scopes.length - existing.length;
  console.log(
    `\nWrote ${scopes.length} scopes to connectors/${name}/connector.json` +
      (added === 0
        ? " (no change in count)."
        : ` (${added > 0 ? "+" : ""}${added}).`),
  );
  console.log(
    "Review the diff — and re-run the registry generator so the change is picked up.",
  );
}

if (require.main === module) void main();
