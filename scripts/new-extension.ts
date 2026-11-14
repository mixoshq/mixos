/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Creates an extension from its kind's template, with its id minted.
 *
 *   npm run new -- app sales-tracker          # apps/sales-tracker-3f9a2c1b/
 *   npm run new -- connector acme             # connectors/acme-<id>/, an API-key service
 *   npm run new -- connector acme --oauth     # from connectors/_template-oauth/
 *   npm run new -- theme dusk                 # themes/dusk-<id>/
 *
 *   npm run new -- app sales-tracker --plan   # apps/sales-tracker-3f9a2c1b/plans/ only
 *   npm run new -- app sales-tracker-3f9a2c1b # later: build that planned folder
 *
 * A new extension's plan is written before its code, inside the folder it will
 * live in (docs/plans/README.md), and a folder holding only `plans/` is
 * *planned, not yet built*: the build skips it. `--plan` mints the id and makes
 * just that. Given the planned folder's name, id and all, this fills it from the
 * template later, leaving the plan as it is.
 *
 * An extension's slug is its name everywhere: its folder, URL, database schema,
 * Registry listing. It ends in an id so two people's `tasks` can be installed
 * side by side, and it is written down once, in the manifest's `registryId`,
 * which the folder is named after (src/lib/extensions/slug-id.ts). So the id
 * is minted here, when the extension is created, before any of its code names
 * it. mixos.org lists the extension under that `registryId` and never mints one
 * of its own.
 *
 * It copies the template, sets `registryId`, and points the template's
 * references to itself at the new name: an app's `callAppRoute("_template", …)`
 * and `/api/apps/_template/…`, a connector's `readonly name`. Everything else is
 * the template's, for you to fill in.
 *
 * Writes files only; it commits nothing. Run `npm run registry` after it.
 */

import fs from "node:fs";
import path from "node:path";
import {
  MANIFEST_FILE,
  REGISTRY_ID_MAX_LENGTH,
  REGISTRY_ID_PATTERN,
  SLUG_ID_LENGTH,
  hasSlugId,
  withRegistryId,
  withSlugId,
} from "../src/lib/extensions/slug-id";

type Kind = "app" | "connector" | "theme";

const KIND_DIR: Record<Kind, string> = { app: "apps", connector: "connectors", theme: "themes" };

/** The text files in a template that can name it. */
const TEXT = /\.(?:ts|tsx|mts|css|md|json)$/;

export class NewExtensionError extends Error {}

export interface NewExtensionOptions {
  /** The checkout's root. */
  root: string;
  kind: Kind;
  /**
   * The name before the id, `sales-tracker`, for a new extension. Or a planned
   * folder's whole name, id and all, `sales-tracker-3f9a2c1b`, to build it.
   */
  base: string;
  /** A connector from the OAuth template. */
  oauth?: boolean;
  /** Mint the id and make only the folder's `plans/`. */
  plan?: boolean;
  /** The registryId to use, for tests. Minted otherwise. */
  registryId?: string;
}

/** The folder it made, relative to the root, and its `registryId`. */
export interface NewExtension {
  dir: string;
  registryId: string;
}

/** The template's own name, quoted, or in an app route's URL. */
function selfReferences(text: string, template: string, registryId: string): string {
  const quoted = new RegExp(`(["'\`])${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g");
  return text
    .replace(quoted, (_m, q: string) => `${q}${registryId}${q}`)
    .replaceAll(`/api/apps/${template}/`, `/api/apps/${registryId}/`);
}

/** Every file under `dir`. */
function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

export function createExtension(opts: NewExtensionOptions): NewExtension {
  const { root, kind, base } = opts;
  if (opts.oauth && kind !== "connector") {
    throw new NewExtensionError("--oauth is for a connector: only connectors have an OAuth template.");
  }
  const kindDir = KIND_DIR[kind];
  // A name with an id is a planned folder, being built: its id was minted
  // when its plan was written.
  const planned = hasSlugId(base);
  if (planned && opts.plan) {
    throw new NewExtensionError(`"${base}" already ends in an id. Give the name without one; --plan mints it.`);
  }
  const longest = REGISTRY_ID_MAX_LENGTH - SLUG_ID_LENGTH - 1;
  const registryId = planned ? base : (opts.registryId ?? withSlugId(base));
  if (!REGISTRY_ID_PATTERN.test(registryId) || registryId.length > REGISTRY_ID_MAX_LENGTH) {
    throw new NewExtensionError(
      `"${base}" can't be a name: use lowercase letters, digits and single hyphens, at most ${longest} characters.`,
    );
  }
  const to = path.join(root, kindDir, registryId);

  if (planned) {
    if (!fs.existsSync(to)) {
      throw new NewExtensionError(
        `There is no ${kindDir}/${registryId} to build. To create a new ${kind}, give its name without an id.`,
      );
    }
    const inside = fs.readdirSync(to).filter((e) => e !== ".DS_Store");
    if (inside.some((e) => e !== "plans")) {
      throw new NewExtensionError(`${kindDir}/${registryId} already holds more than a plan: it is built.`);
    }
  } else if (fs.existsSync(to)) {
    throw new NewExtensionError(`${kindDir}/${registryId} already exists.`);
  }

  if (opts.plan) {
    fs.mkdirSync(path.join(to, "plans"), { recursive: true });
    return { dir: path.relative(root, to), registryId };
  }

  const template = kind === "connector" && opts.oauth ? "_template-oauth" : "_template";
  const from = path.join(root, kindDir, template);
  if (!fs.existsSync(from)) throw new NewExtensionError(`There is no ${kindDir}/${template} to start from.`);

  // Never over a file already there: a planned folder's plan stays as written.
  fs.cpSync(from, to, { recursive: true, force: false });

  const manifestFile = path.join(to, MANIFEST_FILE[kind]);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as Record<string, unknown>;
  fs.writeFileSync(manifestFile, `${JSON.stringify(withRegistryId(manifest, registryId), null, 2)}\n`);

  for (const file of listFiles(to)) {
    if (file === manifestFile || !TEXT.test(file)) continue;
    const text = fs.readFileSync(file, "utf-8");
    const next = selfReferences(text, template, registryId);
    if (next !== text) fs.writeFileSync(file, next);
  }

  return { dir: path.relative(root, to), registryId };
}

function main(): void {
  const args = process.argv.slice(2);
  const oauth = args.includes("--oauth");
  const plan = args.includes("--plan");
  const [kind, base, ...rest] = args.filter((a) => a !== "--oauth" && a !== "--plan");
  if (!kind || !base || rest.length > 0 || !(kind in KIND_DIR)) {
    console.error("Usage: npm run new -- <app|connector|theme> <name> [--plan] [--oauth]");
    process.exit(2);
  }
  let made: NewExtension;
  try {
    made = createExtension({ root: path.resolve(__dirname, ".."), kind: kind as Kind, base, oauth, plan });
  } catch (err) {
    if (err instanceof NewExtensionError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (plan) {
    console.log(`Created ${made.dir}/plans/, for its plan. registryId "${made.registryId}".`);
    console.log(`Once the plan is approved: npm run new -- ${kind} ${made.registryId}`);
    return;
  }
  console.log(`Created ${made.dir}, registryId "${made.registryId}".`);
  console.log(`Fill in its ${MANIFEST_FILE[kind as Kind]}, then run npm run registry.`);
}

if (require.main === module) main();
