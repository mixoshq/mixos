/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the GitHub link is kept: `platform_settings`, one row per fact, no
 * migration.
 *
 *   github_app                   the App: id, slug, name, owner, which key is in use
 *   github_app_key               its private key, AES-256-GCM under GITHUB_APP_ENCRYPTION_KEY
 *   github_link                  the installation and the one repository, and whether it is off
 *   github_branch_rule           what the last read of the default branch's rules found
 *   github_branch_rule_override  an admin's confirmation that another protection applies
 *   github_preview_checklist     an admin's confirmation that no host builds previews of App branches
 *   github_manifest_state        the pending "create the App" round trip: a hash of its state
 *
 * Ids and names are stored as GitHub gave them, after ./identifiers.ts has
 * checked them, and every API path is built from these rows, never from a
 * request or a response. The private key is the only secret, and it is stored
 * only encrypted, under a key of its own (src/lib/env/keys.ts), with the scheme
 * connector credentials use (src/lib/connectors/encryption.ts).
 *
 * Writes that must land together run in one transaction, through `sql`: the
 * query builder has no transactions. Every row is read through a schema, and a
 * row that doesn't fit reads as corrupt rather than as absent, so a damaged
 * record can't look like "no App" and let a second one be created.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import { sql } from "@/lib/db/client";
import { decrypt, encrypt } from "@/lib/connectors/encryption";
import { optionalPlatformKey } from "@/lib/env/keys";
import { isAppSlug, isBranchName, isGitHubId, isLogin, isRepositoryName } from "./identifiers";

export const SETTING = {
  app: "github_app",
  key: "github_app_key",
  link: "github_link",
  branchRule: "github_branch_rule",
  override: "github_branch_rule_override",
  previewChecklist: "github_preview_checklist",
  manifestState: "github_manifest_state",
} as const;

const ALL_KEYS: string[] = Object.values(SETTING);

const Id = z.number().refine(isGitHubId);

export const AppRecordSchema = z.object({
  id: Id,
  slug: z.string().refine(isAppSlug),
  name: z.string().min(1).max(200),
  owner: z.object({
    id: Id,
    login: z.string().refine(isLogin),
    type: z.enum(["User", "Organization"]),
  }),
  /** The fingerprint of the key in github_app_key (./jwt.ts keyFingerprint()). */
  keyFingerprint: z.string(),
  recordedAt: z.string(),
});
export type AppRecord = z.infer<typeof AppRecordSchema>;

export const RepositoryRecordSchema = z.object({
  id: Id,
  owner: z.string().refine(isLogin),
  name: z.string().refine(isRepositoryName),
  defaultBranch: z.string().refine(isBranchName),
  private: z.boolean(),
  fork: z.boolean(),
  /** What it was forked from, as GitHub said at link time. */
  parent: z.object({ id: Id, fullName: z.string() }).nullable(),
});
export type RepositoryRecord = z.infer<typeof RepositoryRecordSchema>;

/** Why a check switched the link off. Each is a change on GitHub that widens what the App reaches. */
export const LINK_PROBLEMS = [
  "all-repositories",
  "more-than-one-repository",
  "repository-changed",
  "upstream",
  "permissions-widened",
  "another-account",
] as const;
export type LinkProblem = (typeof LINK_PROBLEMS)[number];

export const LinkRecordSchema = z.object({
  installationId: Id,
  repository: RepositoryRecordSchema,
  linkedAt: z.string(),
  /** The last check that passed. */
  checkedAt: z.string().nullable(),
  disabled: z
    .object({ at: z.string(), reason: z.enum(LINK_PROBLEMS), detail: z.string() })
    .nullable(),
});
export type LinkRecord = z.infer<typeof LinkRecordSchema>;

export const BranchRuleRecordSchema = z.object({
  repositoryId: Id,
  branch: z.string(),
  checkedAt: z.string(),
  /** Whether a ruleset's `pull_request` rule applies to the branch. */
  pullRequest: z.boolean(),
  /** The types of every rule that applies, for the page. */
  rules: z.array(z.string()),
  /**
   * GitHub's status when it wouldn't let the App read the rules, as it may on a
   * private repository under GitHub Free, which has no rulesets. Linking goes
   * ahead without them; proposals then need an admin's confirmation.
   */
  unreadStatus: z.number().optional(),
});
export type BranchRuleRecord = z.infer<typeof BranchRuleRecordSchema>;

export const OVERRIDE_REASONS = ["classic-protection", "free-private"] as const;
export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

export const OverrideRecordSchema = z.object({
  repositoryId: Id,
  reason: z.enum(OVERRIDE_REASONS),
  at: z.string(),
  by: z.string(),
});
export type OverrideRecord = z.infer<typeof OverrideRecordSchema>;

/**
 * What the App can't read for itself, and an admin confirms before the first
 * proposal: that no host or service builds the App's branches or pull requests
 * with secrets. Render's service previews set in its dashboard, Railway's PR
 * environments and Coolify's preview deployments live in those hosts'
 * settings, not in the repository (./propose.ts reads what is in it).
 */
export const PREVIEW_CHECKLIST = ["render", "railway", "coolify", "other"] as const;
export type PreviewChecklistItem = (typeof PREVIEW_CHECKLIST)[number];

export const PreviewChecklistSchema = z.object({
  repositoryId: Id,
  items: z.array(z.enum(PREVIEW_CHECKLIST)),
  at: z.string(),
  by: z.string(),
});
export type PreviewChecklistRecord = z.infer<typeof PreviewChecklistSchema>;

export const ManifestStateSchema = z.object({
  /** SHA-256 of the state, hex. The state itself is only in the admin's cookie. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  userId: z.string().min(1),
  expiresAt: z.string(),
});
export type ManifestState = z.infer<typeof ManifestStateSchema>;

/** A row that doesn't fit its schema. Nothing acts on it until an admin unlinks. */
export class CorruptRecordError extends Error {
  constructor(readonly key: string) {
    super(`The stored GitHub link (${key}) can't be read. Unlink, then link again.`);
    this.name = "CorruptRecordError";
  }
}

function parseRow<T>(schema: z.ZodType<T>, key: string, value: string | undefined): T | null {
  if (value === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new CorruptRecordError(key);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new CorruptRecordError(key);
  return parsed.data;
}

/** Everything stored about the link, read in one query. The key stays encrypted. */
export interface GitHubState {
  app: AppRecord | null;
  /** Whether an encrypted key is stored. */
  hasKey: boolean;
  link: LinkRecord | null;
  branchRule: BranchRuleRecord | null;
  override: OverrideRecord | null;
  /** Null unless every item is confirmed, for the linked repository. */
  previewChecklist: PreviewChecklistRecord | null;
}

/** The pool, or a transaction on it. */
type Db = Sql | TransactionSql;

async function rows(db: Db, keys: string[]): Promise<Map<string, string>> {
  const found = (await db`
    select key, value from public.platform_settings where key = any(${keys})
  `) as unknown as { key: string; value: string }[];
  return new Map(found.map((r) => [r.key, r.value]));
}

export async function readGitHubState(db: Db = sql): Promise<GitHubState> {
  const found = await rows(db, [
    SETTING.app,
    SETTING.key,
    SETTING.link,
    SETTING.branchRule,
    SETTING.override,
    SETTING.previewChecklist,
  ]);
  const link = parseRow(LinkRecordSchema, SETTING.link, found.get(SETTING.link));
  const branchRule = parseRow(BranchRuleRecordSchema, SETTING.branchRule, found.get(SETTING.branchRule));
  const override = parseRow(OverrideRecordSchema, SETTING.override, found.get(SETTING.override));
  const checklist = parseRow(PreviewChecklistSchema, SETTING.previewChecklist, found.get(SETTING.previewChecklist));
  return {
    app: parseRow(AppRecordSchema, SETTING.app, found.get(SETTING.app)),
    hasKey: found.has(SETTING.key),
    link,
    // A rule or an override for a repository other than the linked one says
    // nothing about it.
    branchRule: branchRule && link && branchRule.repositoryId === link.repository.id ? branchRule : null,
    override: override && link && override.repositoryId === link.repository.id ? override : null,
    previewChecklist:
      checklist &&
      link &&
      checklist.repositoryId === link.repository.id &&
      PREVIEW_CHECKLIST.every((item) => checklist.items.includes(item))
        ? checklist
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  The private key                                                             */
/* -------------------------------------------------------------------------- */

/** Why the stored key can't be used. */
export type KeyProblem =
  /** GITHUB_APP_ENCRYPTION_KEY is unset: the feature is off. */
  | "off"
  /** GITHUB_APP_ENCRYPTION_KEY is set, but not to 32 bytes. */
  | "malformed"
  /** No key is stored. */
  | "missing"
  /** The stored key doesn't decrypt under GITHUB_APP_ENCRYPTION_KEY. */
  | "undecryptable";

export class KeyUnavailableError extends Error {
  constructor(readonly problem: KeyProblem) {
    super(KEY_PROBLEM_MESSAGES[problem]);
    this.name = "KeyUnavailableError";
  }
}

export const KEY_PROBLEM_MESSAGES: Record<KeyProblem, string> = {
  off: "The GitHub App is off: GITHUB_APP_ENCRYPTION_KEY isn't set.",
  malformed: "GITHUB_APP_ENCRYPTION_KEY isn't 32 bytes, so the GitHub App is off until it is fixed.",
  missing: "No private key is stored for the App. Replace the private key with one generated on GitHub.",
  undecryptable:
    "The App's private key doesn't decrypt with GITHUB_APP_ENCRYPTION_KEY. If the key was rotated, re-encrypt " +
    "the stored key with npm run keys:rotate-github-app. Otherwise, replace the private key.",
};

/** GITHUB_APP_ENCRYPTION_KEY, or why there is none. */
export function encryptionKeyState(): { ok: true; key: Buffer } | { ok: false; problem: "off" | "malformed" } {
  try {
    const key = optionalPlatformKey("githubAppEncryption");
    return key ? { ok: true, key } : { ok: false, problem: "off" };
  } catch {
    return { ok: false, problem: "malformed" };
  }
}

/** GITHUB_APP_ENCRYPTION_KEY, or a KeyUnavailableError. */
export function encryptionKey(): Buffer {
  const state = encryptionKeyState();
  if (!state.ok) throw new KeyUnavailableError(state.problem);
  return state.key;
}

export function sealPrivateKey(pem: string, key: Buffer = encryptionKey()): string {
  return encrypt(pem, key);
}

/** Decrypt a stored key, or a KeyUnavailableError. GCM's tag check fails on any other key. */
export function openPrivateKey(stored: string, key: Buffer = encryptionKey()): string {
  try {
    return decrypt(stored, key);
  } catch {
    throw new KeyUnavailableError("undecryptable");
  }
}

/** The stored key, decrypted. For one operation; never kept. */
export async function readPrivateKeyPem(db: Db = sql): Promise<string> {
  const key = encryptionKey();
  const found = await rows(db, [SETTING.key]);
  const stored = found.get(SETTING.key);
  if (!stored) throw new KeyUnavailableError("missing");
  return openPrivateKey(stored, key);
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                      */
/* -------------------------------------------------------------------------- */

async function put(db: Db, key: string, value: string): Promise<void> {
  await db`
    insert into public.platform_settings (key, value, updated_at)
    values (${key}, ${value}, now())
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
  `;
}

/**
 * Record a new App and its encrypted key, together, only while no App is
 * recorded. False when one is: one App at a time.
 */
export async function recordApp(app: AppRecord, sealedKey: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const inserted = (await tx`
      insert into public.platform_settings (key, value, updated_at)
      values (${SETTING.app}, ${JSON.stringify(app)}, now())
      on conflict (key) do nothing
      returning key
    `) as unknown as unknown[];
    if (inserted.length === 0) return false;
    await put(tx, SETTING.key, sealedKey);
    // Nothing from before this App can describe it.
    await tx`delete from public.platform_settings where key = any(${[
      SETTING.link,
      SETTING.branchRule,
      SETTING.override,
      SETTING.previewChecklist,
    ]})`;
    return true;
  });
}

/** Replace the App's key, and the fingerprint its record names, together. False when the App changed. */
export async function replaceAppKey(appId: number, sealedKey: string, fingerprint: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const found = await rows(tx, [SETTING.app]);
    const app = parseRow(AppRecordSchema, SETTING.app, found.get(SETTING.app));
    if (!app || app.id !== appId) return false;
    await put(tx, SETTING.app, JSON.stringify({ ...app, keyFingerprint: fingerprint }));
    await put(tx, SETTING.key, sealedKey);
    return true;
  });
}

/** Record the link, only while none is. False when one is. */
export async function recordLink(link: LinkRecord, rule: BranchRuleRecord | null): Promise<boolean> {
  return sql.begin(async (tx) => {
    const inserted = (await tx`
      insert into public.platform_settings (key, value, updated_at)
      values (${SETTING.link}, ${JSON.stringify(link)}, now())
      on conflict (key) do nothing
      returning key
    `) as unknown as unknown[];
    if (inserted.length === 0) return false;
    // Anything left from an earlier link describes another repository.
    await tx`delete from public.platform_settings where key = any(${[SETTING.override, SETTING.previewChecklist]})`;
    if (rule) await put(tx, SETTING.branchRule, JSON.stringify(rule));
    else await tx`delete from public.platform_settings where key = ${SETTING.branchRule}`;
    return true;
  });
}

/**
 * Change the link record, under a row lock, when it still names `installationId`.
 * `change` returns the new record, or null to leave it. Returns what is stored after.
 */
export async function updateLink(
  installationId: number,
  change: (current: LinkRecord) => LinkRecord | null,
): Promise<LinkRecord | null> {
  return sql.begin(async (tx) => {
    const found = (await tx`
      select value from public.platform_settings where key = ${SETTING.link} for update
    `) as unknown as { value: string }[];
    const current = parseRow(LinkRecordSchema, SETTING.link, found[0]?.value);
    if (!current || current.installationId !== installationId) return current;
    const next = change(current);
    if (!next) return current;
    await put(tx, SETTING.link, JSON.stringify(next));
    return next;
  });
}

export async function saveBranchRule(rule: BranchRuleRecord): Promise<void> {
  await put(sql, SETTING.branchRule, JSON.stringify(rule));
}

export async function saveOverride(override: OverrideRecord): Promise<void> {
  await put(sql, SETTING.override, JSON.stringify(override));
}

export async function clearOverride(): Promise<boolean> {
  const deleted = (await sql`
    delete from public.platform_settings where key = ${SETTING.override} returning key
  `) as unknown as unknown[];
  return deleted.length > 0;
}

export async function savePreviewChecklist(checklist: PreviewChecklistRecord): Promise<void> {
  await put(sql, SETTING.previewChecklist, JSON.stringify(checklist));
}

export async function clearPreviewChecklist(): Promise<boolean> {
  const deleted = (await sql`
    delete from public.platform_settings where key = ${SETTING.previewChecklist} returning key
  `) as unknown as unknown[];
  return deleted.length > 0;
}

/** Forget the App, its key and the link: every row above, in one statement. */
export async function forgetEverything(): Promise<void> {
  await sql`delete from public.platform_settings where key = any(${ALL_KEYS})`;
}

/* -------------------------------------------------------------------------- */
/*  The manifest round trip                                                     */
/* -------------------------------------------------------------------------- */

export async function saveManifestState(state: ManifestState): Promise<void> {
  await put(sql, SETTING.manifestState, JSON.stringify(state));
}

/** The hash the pending round trip is stored under: the state itself is only in the admin's cookie. */
export function manifestStateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/**
 * Take the pending round trip if its state is `state`, deleting it, so a state
 * works once. Null when nothing is pending or the state doesn't match, which
 * leaves the pending one alone: a wrong guess can't cancel an admin's round trip.
 */
export async function consumeManifestState(state: string): Promise<ManifestState | null> {
  return sql.begin(async (tx) => {
    const found = (await tx`
      select value from public.platform_settings where key = ${SETTING.manifestState} for update
    `) as unknown as { value: string }[];
    let pending: ManifestState | null;
    try {
      pending = parseRow(ManifestStateSchema, SETTING.manifestState, found[0]?.value);
    } catch {
      pending = null;
    }
    if (!pending) return null;
    const expected = Buffer.from(pending.hash, "hex");
    const given = Buffer.from(manifestStateHash(state), "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    await tx`delete from public.platform_settings where key = ${SETTING.manifestState}`;
    return pending;
  });
}
