/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which instance this checkout is, and the ports it owns.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * An instance is a compose project, its named volumes and its Supabase
 * containers, all named after it, and the ports it publishes. Two checkouts with
 * one name are one instance: booting the second recreates the first.
 *
 * A second instance is what developing an extension and *installing* one need,
 * because they are different jobs that cannot share a tree — registration
 * refuses a slug whose directory already exists (`src/lib/repository/install.ts`).
 * Verifying that an extension installs the way a stranger would get it needs a
 * second instance, running at the same time as the one it was authored in.
 *
 * ── THE DEFAULTS ────────────────────────────────────────────────────────────
 *
 * A checkout with no `.env.instance` is the `mixos` project on port 3000 with
 * Supabase on 54321, as the docs say. A second instance takes its own name and
 * ports; the first keeps the defaults.
 *
 * ── WHY THE PORTS ARE DERIVED FROM ONE BASE ─────────────────────────────────
 *
 * Supabase publishes seven ports and `config.toml` cannot do arithmetic, so
 * something has to compute them. Doing it here from a single base keeps the
 * per-instance file to three lines instead of ten, and keeps the offsets — the
 * part nobody will remember — in one place. The offsets below are the ones
 * config.toml's defaults use relative to 54320, so the default base reproduces
 * them exactly.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** The instance name when nothing says otherwise. */
export const DEFAULT_INSTANCE = "mixos";

/** 54320. Supabase's own default, and the base config.toml's defaults are written against. */
export const DEFAULT_SUPABASE_PORT_BASE = 54320;

export const DEFAULT_APP_PORT = 3000;

/**
 * Per-instance settings, read before anything else.
 *
 * Git-ignored by the existing `.env*` rule, so it cannot travel to another
 * machine or into a release — which matters, because a committed instance name
 * would make every checkout of that release the same instance again.
 */
const INSTANCE_FILE = ".env.instance";

/**
 * Offsets from the base, matching the committed config.toml exactly:
 * shadow 54320, api 54321, db 54322, studio 54323, smtp 54324, analytics
 * 54327, pooler 54329.
 */
const OFFSETS = {
  shadow: 0,
  api: 1,
  db: 2,
  studio: 3,
  smtp: 4,
  analytics: 7,
  pooler: 9,
} as const;

/**
 * The edge-runtime inspector. Not part of the 5432x block — it is 8083, a port
 * from a different neighbourhood — so it gets its own variable rather than an
 * offset that would put it somewhere it has never been.
 */
export const DEFAULT_INSPECTOR_PORT = 8083;

export interface InstancePorts {
  app: number;
  supabaseApi: number;
  supabaseDb: number;
  supabaseShadow: number;
  supabaseStudio: number;
  supabaseSmtp: number;
  supabaseAnalytics: number;
  supabasePooler: number;
  supabaseInspector: number;
}

export interface Instance {
  /** Compose project name, Supabase project id, and what the docs call it. */
  name: string;
  ports: InstancePorts;
  /** True when this checkout is the default — used only to keep output quiet. */
  isDefault: boolean;
}

/**
 * Read `.env.instance` into `process.env` WITHOUT overriding anything already
 * set, so `MIXOS_INSTANCE=x npm run dev:docker` beats the file.
 *
 * Deliberately not `loadEnv()` from `./load-env`: that one decides between the
 * hosted and Docker env files and rewrites container addresses for host-side
 * scripts. This runs before any of that is relevant and must not drag it in —
 * `docker-down.ts` in particular has to work on a half-finished checkout where
 * none of those files exist yet.
 */
function loadInstanceFile(): void {
  const full = path.join(ROOT, INSTANCE_FILE);
  if (!fs.existsSync(full)) return;

  for (const line of fs.readFileSync(full, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * A name that is safe as a compose project, a Supabase project id, and half of
 * a container name.
 *
 * Docker allows `[a-z0-9][a-z0-9_-]*` for a project name, and an invalid one
 * fails deep inside compose with a message about a label. Rejecting it here
 * names the file the developer has to fix.
 */
function validName(raw: string): string {
  const name = raw.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      `MIXOS_INSTANCE must be lowercase letters, digits, dashes or underscores, ` +
        `starting with a letter or digit. Got "${raw}" (from ${INSTANCE_FILE} or the shell).`,
    );
  }
  return name;
}

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`${key} must be a port number between 1 and 65535. Got "${raw}".`);
  }
  return n;
}

/**
 * Resolve this checkout's identity and WRITE IT BACK into `process.env`.
 *
 * The write-back is the point. `docker compose` reads `${MIXOS_INSTANCE}` out
 * of its own environment, and the Supabase CLI resolves `env(...)` in
 * config.toml out of its own — both inherited from this process. Setting them
 * here means every child gets them without a single call site having to
 * remember to pass an env object, which is exactly the kind of thing one of
 * the four `spawnSync`s in docker-up.ts would eventually forget.
 *
 * Safe to call more than once.
 */
export function resolveInstance(): Instance {
  loadInstanceFile();

  const name = validName(process.env.MIXOS_INSTANCE ?? DEFAULT_INSTANCE);
  const base = intFromEnv("MIXOS_SUPABASE_PORT_BASE", DEFAULT_SUPABASE_PORT_BASE);

  const ports: InstancePorts = {
    app: intFromEnv("MIXOS_PORT", DEFAULT_APP_PORT),
    supabaseApi: base + OFFSETS.api,
    supabaseDb: base + OFFSETS.db,
    supabaseShadow: base + OFFSETS.shadow,
    supabaseStudio: base + OFFSETS.studio,
    supabaseSmtp: base + OFFSETS.smtp,
    supabaseAnalytics: base + OFFSETS.analytics,
    supabasePooler: base + OFFSETS.pooler,
    supabaseInspector: intFromEnv("MIXOS_INSPECTOR_PORT", DEFAULT_INSPECTOR_PORT),
  };

  // Written back for the children: compose reads MIXOS_INSTANCE and MIXOS_PORT,
  // the Supabase CLI reads the rest through env() in config.toml.
  process.env.MIXOS_INSTANCE = name;
  process.env.MIXOS_PORT = String(ports.app);
  process.env.MIXOS_SUPABASE_API_PORT = String(ports.supabaseApi);
  process.env.MIXOS_SUPABASE_DB_PORT = String(ports.supabaseDb);
  process.env.MIXOS_SUPABASE_SHADOW_PORT = String(ports.supabaseShadow);
  process.env.MIXOS_SUPABASE_STUDIO_PORT = String(ports.supabaseStudio);
  process.env.MIXOS_SUPABASE_SMTP_PORT = String(ports.supabaseSmtp);
  process.env.MIXOS_SUPABASE_ANALYTICS_PORT = String(ports.supabaseAnalytics);
  process.env.MIXOS_SUPABASE_POOLER_PORT = String(ports.supabasePooler);
  process.env.MIXOS_SUPABASE_INSPECTOR_PORT = String(ports.supabaseInspector);

  return { name, ports, isDefault: name === DEFAULT_INSTANCE };
}
