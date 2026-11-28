/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One runner bundle per registered connector (Item 7b):
 * `runner-bundles/connectors/<name>/bundle.mjs`, the connector's code and
 * src/lib/runners/connector-host.ts in one file, which a connector runner
 * loads (src/lib/runners/remote-connector.ts). Run by `npm run prebuild`,
 * after the registry generator, so `npm run build` makes them and the image
 * carries them (next.config.ts traces the folder).
 *
 * What a bundle doesn't carry:
 *
 *   - **Other connectors.** The generated connector registry is replaced by
 *     one holding this connector's manifest alone.
 *   - **The database and the platform's connector config.** `@/lib/db/*`, and
 *     the `./config` HttpConnector imports only to renew a grant, are stubs
 *     whose every member throws: a runner renews a grant through the
 *     platform, and reaches no database. A connector that imports one loads,
 *     and fails where it uses it.
 *
 * Fails the build when a bundle can't be made: a connector the tier would run
 * isolated must have one. Skipped on Vercel, which has no runners.
 */

import fs from "node:fs";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import type { ConnectorManifest } from "../src/lib/connectors/types";

const ROOT = path.resolve(__dirname, "..");
export const BUNDLE_ROOT = path.join(ROOT, "runner-bundles");
const HOST = path.join(ROOT, "src/lib/runners/connector-host.ts");
const HTTP_CONNECTOR = path.join(ROOT, "src/lib/connectors/http-connector.ts");

const UNAVAILABLE = (what: string) => `
const refuse = () => { throw new Error(${JSON.stringify(`${what} isn't available in a connector's runner: the platform holds it.`)}); };
module.exports = new Proxy({}, {
  get(_, key) {
    if (key === "__esModule" || typeof key === "symbol") return undefined;
    return new Proxy(function () {}, { apply: refuse, get: refuse, construct: refuse });
  },
});
`;

function runnerStubs(manifest: ConnectorManifest & { name: string }): Plugin {
  return {
    name: "mixos-runner-stubs",
    setup(b) {
      b.onResolve({ filter: /^@\/generated\/connector-registry$/ }, () => ({ path: "connector-registry", namespace: "mixos-runner" }));
      b.onResolve({ filter: /^@\/lib\/db(\/.*)?$/ }, (args) => ({ path: args.path, namespace: "mixos-runner-unavailable" }));
      b.onResolve({ filter: /^\.\/config$/ }, (args) =>
        path.resolve(args.importer) === HTTP_CONNECTOR ? { path: "connector-config", namespace: "mixos-runner-unavailable" } : undefined,
      );
      b.onResolve({ filter: /^@\/lib\/connectors\/config$/ }, () => ({ path: "connector-config", namespace: "mixos-runner-unavailable" }));
      b.onLoad({ filter: /.*/, namespace: "mixos-runner" }, () => ({
        contents: `export const connectorRegistry = [${JSON.stringify(manifest)}];`,
        loader: "js",
      }));
      b.onLoad({ filter: /.*/, namespace: "mixos-runner-unavailable" }, (args) => ({
        contents: UNAVAILABLE(args.path === "connector-config" ? "The connector config" : `The database (${args.path})`),
        loader: "js",
      }));
    },
  };
}

/** Build one connector's bundle into `outRoot/connectors/<name>/bundle.mjs`. */
export async function buildConnectorBundle(
  manifest: ConnectorManifest & { name: string },
  outRoot: string = BUNDLE_ROOT,
  indexPath: string = path.join(ROOT, "connectors", manifest.name, "index.ts"),
): Promise<string> {
  const outfile = path.join(outRoot, "connectors", manifest.name, "bundle.mjs");
  await build({
    stdin: {
      contents:
        `import * as mod from ${JSON.stringify(indexPath)};\n` +
        `import { serveConnector } from ${JSON.stringify(HOST)};\n` +
        `export const run = serveConnector(mod);\n`,
      resolveDir: ROOT,
      sourcefile: `runner-entry-${manifest.name}.ts`,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    tsconfig: path.join(ROOT, "tsconfig.json"),
    plugins: [runnerStubs(manifest)],
    define: { "process.env.NODE_ENV": '"production"' },
    // A CommonJS dependency's require() of a Node builtin.
    banner: { js: 'import { createRequire as __mixosRequire } from "node:module";\nconst require = __mixosRequire(import.meta.url);' },
    legalComments: "none",
    logLevel: "silent",
  });
  return outfile;
}

async function main() {
  if (process.env.VERCEL) {
    console.log("Runner bundles: skipped on Vercel, which has no runners.");
    return;
  }
  const { connectorRegistry } = await import("../src/generated/connector-registry");
  fs.rmSync(path.join(BUNDLE_ROOT, "connectors"), { recursive: true, force: true });
  const failed: string[] = [];
  for (const manifest of connectorRegistry) {
    try {
      await buildConnectorBundle(manifest as ConnectorManifest & { name: string });
    } catch (error) {
      failed.push(`  - ${manifest.name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  if (failed.length > 0) {
    console.error(`Runner bundles: ${failed.length} connector(s) couldn't be bundled, and wouldn't run isolated:\n${failed.join("\n")}`);
    process.exit(1);
  }
  console.log(`Runner bundles: ${connectorRegistry.length} connector bundle(s) in runner-bundles/connectors/.`);
}

if (require.main === module) void main();
