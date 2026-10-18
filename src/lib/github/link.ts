/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Admin > GitHub: link this instance to the one repository it is built from,
 * through a private GitHub App the operator owns. The work behind the server
 * actions in ./actions.ts and the two routes GitHub sends the admin back to.
 *
 * ── THE STEPS ───────────────────────────────────────────────────────────────
 *
 *   1. Create. The page posts a manifest to GitHub (./manifest.ts) with a
 *      `state` that works once, for 15 minutes, for the admin who started it
 *      and in the browser holding its cookie. GitHub creates the App and sends
 *      the admin back with a code, which is exchanged at once for the App's id,
 *      slug and first private key. The webhook secret and OAuth secret in the
 *      same answer are dropped. The key is stored encrypted (./store.ts).
 *   2. Install. The admin installs the App on GitHub, on "Only select
 *      repositories", choosing the repository this instance is built from.
 *   3. Finish linking. The App's installation is read with its JWT, its
 *      repositories counted with a metadata-only token (./installation.ts), and
 *      the link refused unless it covers exactly one repository, chosen, that
 *      isn't upstream MixOS. Then the repository and its default branch's rules
 *      are read with a read token narrowed to it, and recorded.
 *
 * One App at a time: a new one can't be created while one is recorded, so
 * linking another repository means unlinking first.
 *
 * ── EVERY OPERATION ─────────────────────────────────────────────────────────
 *
 * Checks the installation again first (`judgeInstallation()`), and switches
 * the link off, audited, when it has widened. `withLinkedRepository()` is that
 * check followed by a narrowed token: the way anything later reaches the
 * repository.
 *
 * ── UNLINKING ───────────────────────────────────────────────────────────────
 *
 * Unlink uninstalls the App through GitHub's API, confirms GitHub lists no
 * installation of it, and only then forgets the key and the ids. When GitHub
 * refuses, nothing here is deleted: forgetting an App that is still installed
 * would leave a key, on GitHub's side, that can still write to the repository,
 * and nothing here to say so. Forget, which skips the uninstall, is only
 * offered once GitHub no longer accepts the stored key, or it can't be read,
 * and needs the App's slug typed.
 *
 * ── RULES FOR EVERY FUNCTION HERE ───────────────────────────────────────────
 *
 *   - The admin first (`ctx.admin()`, which is requireAdmin()), before anything
 *     is read. The routes call requireAdmin() themselves and pass the admin in.
 *   - Changes take the `github.app` lock, and confirm it before each write.
 *   - The answer is a value, never a throw: what went wrong, said plainly, and
 *     never a token, a JWT or the key (./outcomes.ts).
 *   - Linking, unlinking, forgetting, replacing the key, switching the link off
 *     or on, confirming another branch protection and confirming the preview
 *     checklist are audited (§28 of docs/security-architecture.md), as
 *     `github.*` against the App.
 *
 * Proposing an extension as a pull request, which uses the link, is
 * ./propose.ts.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import { LockUnavailableError, withPlatformLock, type PlatformLease } from "@/lib/platform/lock";
import { GitHubError, githubRequest, segment } from "./api";
import { isAppName, isGitHubId, isLogin, isManifestCode } from "./identifiers";
import {
  appSession,
  countRepositories,
  deleteInstallation,
  judgeInstallation,
  listInstallations,
  mintRepositoryToken,
  readInstallation,
  revokeToken,
  type AppSession,
} from "./installation";
import { appJwt, keyFingerprint, parsePrivateKey, PrivateKeyError, storedPem } from "./jwt";
import {
  APP_PERMISSIONS,
  appManifest,
  appSettingsUrl,
  installAppUrl,
  installationSettingsUrl,
  newAppUrl,
  type AppAccount,
  type TokenShape,
} from "./manifest";
import type { CreatedOutcome, GitHubOutcome, OutcomeLink, OutcomeTone, StartOutcome } from "./outcomes";
import {
  linkedRepository,
  readBranchRulesOrNone,
  readRepository,
  type BranchRules,
  type LinkedRepository,
  type WriteScope,
} from "./repository";
import { AppSchema, ManifestConversionSchema, parseAnswer } from "./schemas";
import {
  CorruptRecordError,
  KeyUnavailableError,
  OVERRIDE_REASONS,
  PREVIEW_CHECKLIST,
  clearOverride,
  clearPreviewChecklist,
  consumeManifestState,
  encryptionKeyState,
  forgetEverything,
  manifestStateHash,
  readGitHubState,
  recordApp,
  recordLink,
  replaceAppKey,
  saveBranchRule,
  saveManifestState,
  saveOverride,
  savePreviewChecklist,
  sealPrivateKey,
  updateLink,
  type AppRecord,
  type BranchRuleRecord,
  type GitHubState,
  type LinkProblem,
  type LinkRecord,
  type RepositoryRecord,
} from "./store";

/** How long the "create the App" round trip may take. */
export const MANIFEST_STATE_TTL_MS = 15 * 60 * 1000;

/** The cookie holding the round trip's state, in the admin's browser only. */
export const MANIFEST_STATE_COOKIE = "mixos_github_manifest";
/** The cookie's path: the route GitHub sends the admin back to. */
export const MANIFEST_STATE_COOKIE_PATH = "/api/admin/github";

/**
 * The lease is a few GitHub requests long, each with a 10-second limit. A
 * proposal's is longer, and the lease renews itself every minute meanwhile.
 */
const LOCK_OPTIONS = { ttlSeconds: 120 };

/** The audit rows' target. */
const TARGET_TYPE = "github-app";

export interface LinkContext {
  /** The signed-in admin: requireAdmin(). Called first. */
  admin(): Promise<AdminActor>;
  /** This instance's public URL: getAppOrigin(). Throws when it can't be worked out. */
  origin(): string;
  now?(): Date;
}

const nowOf = (ctx: { now?(): Date }) => (ctx.now ? ctx.now() : new Date());

/* -------------------------------------------------------------------------- */
/*  Saying what happened                                                        */
/* -------------------------------------------------------------------------- */

export function refused(
  code: string,
  message: string,
  tone: OutcomeTone = "warning",
  links?: OutcomeLink[],
): Extract<GitHubOutcome, { ok: false }> {
  return { ok: false, code, message, tone, ...(links ? { links } : {}) };
}

const OFF = refused(
  "off",
  "The GitHub App is off. Set GITHUB_APP_ENCRYPTION_KEY where this instance runs, then restart it.",
  "info",
);
const MALFORMED = refused(
  "malformed-key",
  "GITHUB_APP_ENCRYPTION_KEY isn't 32 bytes, so the GitHub App is off until it is fixed.",
  "danger",
);
const BUSY = refused(
  "busy",
  "Another administrator is changing the GitHub link. Try again in a moment.",
  "neutral",
);

/** The feature's switch, as a refusal, or null when it is on. */
export function featureRefusal(): Extract<GitHubOutcome, { ok: false }> | null {
  const state = encryptionKeyState();
  if (state.ok) return null;
  return state.problem === "off" ? OFF : MALFORMED;
}

/** What a GitHub failure means to the admin. The message names the request and status, never a credential. */
function describeGitHubError(err: GitHubError): string {
  switch (err.failure) {
    case "unreachable":
      return `GitHub couldn't be reached, so nothing changed. Try again. (${err.message})`;
    case "unauthorized":
      return (
        "GitHub didn't accept the App's private key. If the key was deleted on GitHub, replace it with a " +
        `new one. (${err.message})`
      );
    default:
      return err.message;
  }
}

/** Any failure as an answer. Unexpected ones are logged by name and message only. */
export function fromError(err: unknown): Extract<GitHubOutcome, { ok: false }> {
  if (err instanceof LockUnavailableError) return BUSY;
  if (err instanceof KeyUnavailableError) return refused(`key-${err.problem}`, err.message, "danger");
  if (err instanceof CorruptRecordError) return refused("corrupt", err.message, "danger");
  if (err instanceof GitHubError) {
    const tone = err.failure === "unreachable" ? "neutral" : "warning";
    return refused(`github-${err.failure}`, describeGitHubError(err), tone);
  }
  // Not the error object: a database error carries its query's parameters.
  console.error(`[github] Unexpected failure: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown"}`);
  return refused("error", "Something unexpected stopped it. The server log says what.", "danger");
}

async function audit(
  actor: AdminActor,
  action: string,
  app: Pick<AppRecord, "id" | "slug"> | null,
  details: Record<string, unknown>,
): Promise<void> {
  await recordAdminAction(actor, {
    action,
    targetType: TARGET_TYPE,
    targetId: app ? String(app.id) : undefined,
    details: app ? { appSlug: app.slug, ...details } : details,
  });
}

function fullName(record: Pick<RepositoryRecord, "owner" | "name">): string {
  return `${record.owner}/${record.name}`;
}

/** Run `fn` under the `github.app` lock: every change to the link, and every proposal. */
export function locked<T>(fn: (lease: PlatformLease) => Promise<T>): Promise<T> {
  return withPlatformLock("github.app", fn, LOCK_OPTIONS);
}

/* -------------------------------------------------------------------------- */
/*  1. Create the App                                                           */
/* -------------------------------------------------------------------------- */

const StartInputSchema = z.object({
  account: z.enum(["user", "organization"]),
  organization: z.string().optional(),
  name: z.string(),
});

/**
 * Begin creating the App: a fresh state, kept hashed for the signed-in admin,
 * and the manifest and the GitHub URL the page posts it to. The state also
 * goes in an HttpOnly cookie, which the caller sets.
 */
export async function startAppCreation(
  input: unknown,
  ctx: LinkContext,
): Promise<{ outcome: StartOutcome; cookieState: string | null }> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return { outcome: off, cookieState: null };

  const parsed = StartInputSchema.safeParse(input);
  if (!parsed.success) {
    return { outcome: refused("input", "Choose an account and a name for the App."), cookieState: null };
  }
  const name = parsed.data.name.trim();
  if (!isAppName(name)) {
    return {
      outcome: refused("name", "The App's name is 1 to 34 characters, with no control characters."),
      cookieState: null,
    };
  }
  let account: AppAccount = { type: "user" };
  if (parsed.data.account === "organization") {
    const login = parsed.data.organization?.trim() ?? "";
    if (!isLogin(login)) {
      return {
        outcome: refused("organization", "Type the organization's login as it appears in its GitHub URL."),
        cookieState: null,
      };
    }
    account = { type: "organization", login };
  }
  if (!actor.id) return { outcome: refused("actor", "Sign in as an administrator."), cookieState: null };

  try {
    const state = await readGitHubState();
    if (state.app) {
      return {
        outcome: refused(
          "exists",
          `This instance already has an App, ${state.app.name}. Unlink it before creating another.`,
        ),
        cookieState: null,
      };
    }
    let origin: string;
    try {
      origin = ctx.origin();
    } catch {
      return {
        outcome: refused(
          "origin",
          "This instance's public URL isn't set, so GitHub would have nowhere to send you back. Set NEXTAUTH_URL.",
        ),
        cookieState: null,
      };
    }

    const value = randomBytes(32).toString("base64url");
    await saveManifestState({
      hash: manifestStateHash(value),
      userId: actor.id,
      expiresAt: new Date(nowOf(ctx).getTime() + MANIFEST_STATE_TTL_MS).toISOString(),
    });
    return {
      outcome: { ok: true, action: newAppUrl(account, value), manifest: JSON.stringify(appManifest(origin, name)) },
      cookieState: value,
    };
  } catch (err) {
    return { outcome: fromError(err), cookieState: null };
  }
}

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Whether the App GitHub created asks for exactly the permissions and events the manifest did. */
function asManifested(permissions: Record<string, string>, events: string[]): boolean {
  const asked = Object.entries(APP_PERMISSIONS);
  return (
    events.length === 0 &&
    Object.keys(permissions).length === asked.length &&
    asked.every(([name, level]) => permissions[name] === level)
  );
}

/**
 * GitHub sent the admin back with `code` and `state`: check the state, exchange
 * the code for the App, and record it. `actor` is the admin requireAdmin()
 * returned to the route. Answers with a code for the page (./outcomes.ts).
 */
export async function finishAppCreation(
  input: { code: string | null; state: string | null; cookieState: string | null },
  actor: AdminActor,
  ctx: { now?(): Date } = {},
): Promise<CreatedOutcome> {
  if (featureRefusal()) return "off";
  const { code, state, cookieState } = input;
  if (!code || !state || !cookieState || !isManifestCode(code) || !sameState(state, cookieState)) {
    await audit(actor, "github.app.create.rejected", null, { reason: "state" });
    return "state";
  }

  try {
    return await locked(async (lease) => {
      const pending = await consumeManifestState(state);
      if (!pending || pending.userId !== actor.id || Date.parse(pending.expiresAt) <= nowOf(ctx).getTime()) {
        await audit(actor, "github.app.create.rejected", null, { reason: "state" });
        return "state";
      }
      if ((await readGitHubState()).app) {
        await audit(actor, "github.app.create.rejected", null, { reason: "exists" });
        return "exists";
      }

      let conversion;
      try {
        const { data } = await githubRequest(`/app-manifests/${segment(code)}/conversions`, {
          method: "POST",
          auth: { kind: "none" },
          label: "/app-manifests/{code}/conversions",
        });
        // Only what is kept is read out: the webhook and OAuth secrets in the
        // same answer are never parsed, stored or passed on.
        conversion = parseAnswer(ManifestConversionSchema, data, "POST /app-manifests/{code}/conversions");
      } catch (err) {
        await audit(actor, "github.app.create.rejected", null, {
          reason: "conversion",
          status: err instanceof GitHubError ? (err.status ?? null) : null,
        });
        if (!(err instanceof GitHubError)) throw err;
        console.warn(`[github] Creating the App: ${err.message}`);
        return "conversion-failed";
      }

      const owner = conversion.owner;
      const ownerType = owner.type === "Organization" ? "Organization" : owner.type === "User" ? "User" : null;
      if (!ownerType || !asManifested(conversion.permissions, conversion.events)) {
        await audit(actor, "github.app.create.rejected", { id: conversion.id, slug: conversion.slug }, {
          reason: "permissions",
          permissions: conversion.permissions,
          events: conversion.events,
        });
        return "permissions";
      }

      let fingerprint: string;
      let sealed: string;
      try {
        const key = parsePrivateKey(conversion.pem);
        fingerprint = keyFingerprint(key);
        sealed = sealPrivateKey(storedPem(key));
      } catch (err) {
        if (!(err instanceof PrivateKeyError)) throw err;
        await audit(actor, "github.app.create.rejected", { id: conversion.id, slug: conversion.slug }, {
          reason: "key",
        });
        return "conversion-failed";
      }

      const app: AppRecord = {
        id: conversion.id,
        slug: conversion.slug,
        name: conversion.name,
        owner: { id: owner.id, login: owner.login, type: ownerType },
        keyFingerprint: fingerprint,
        recordedAt: nowOf(ctx).toISOString(),
      };
      await lease.assertHeld();
      if (!(await recordApp(app, sealed))) {
        await audit(actor, "github.app.create.rejected", { id: app.id, slug: app.slug }, { reason: "exists" });
        return "exists";
      }
      await audit(actor, "github.app.create", app, {
        name: app.name,
        owner: app.owner.login,
        ownerType: app.owner.type,
        keyFingerprint: fingerprint,
        permissions: conversion.permissions,
      });
      return "created";
    });
  } catch (err) {
    if (err instanceof LockUnavailableError) return "busy";
    fromError(err);
    return "error";
  }
}

/* -------------------------------------------------------------------------- */
/*  3. Finish linking                                                           */
/* -------------------------------------------------------------------------- */

const FinishInputSchema = z.object({ installationId: z.number().optional() }).optional();

/**
 * Read the repository and its default branch's rules with a read token
 * narrowed to it, revoked after. Both paths come from `record`, and GitHub's
 * answer has to agree with it on the default branch.
 */
async function readLinked(
  session: AppSession,
  installationId: number,
  record: RepositoryRecord,
): Promise<{ record: RepositoryRecord; rules: BranchRules }> {
  const token = await mintRepositoryToken(session, installationId, record.id, "read");
  try {
    const repo = linkedRepository(record, "read", token);
    const details = await readRepository(repo);
    if (details.default_branch !== record.defaultBranch) {
      throw new GitHubError(
        "GitHub gave two different default branches for the repository. Check again in a moment.",
        "malformed",
      );
    }
    const rules = await readBranchRulesOrNone(repo);
    return {
      record: {
        ...record,
        private: details.private,
        fork: details.fork,
        parent: details.parent ? { id: details.parent.id, fullName: details.parent.full_name } : null,
      },
      rules,
    };
  } finally {
    await revokeToken(token);
  }
}

function recordFrom(repository: {
  id: number;
  owner: { login: string };
  name: string;
  default_branch: string;
  private: boolean;
  fork: boolean;
}): RepositoryRecord {
  return {
    id: repository.id,
    owner: repository.owner.login,
    name: repository.name,
    defaultBranch: repository.default_branch,
    private: repository.private,
    fork: repository.fork,
    parent: null,
  };
}

/** What a read of the rules found, as it is stored. */
export function ruleRecord(record: RepositoryRecord, rules: BranchRules, at: Date): BranchRuleRecord {
  return {
    repositoryId: record.id,
    branch: rules.branch,
    checkedAt: at.toISOString(),
    pullRequest: rules.pullRequest,
    rules: rules.rules,
    ...(rules.unreadStatus !== undefined ? { unreadStatus: rules.unreadStatus } : {}),
  };
}

/** What the last read of the rules found, in a sentence. */
function ruleSentence(rules: BranchRules): string {
  if (rules.unreadStatus !== undefined) {
    return `GitHub didn't let the App read the rules on ${rules.branch} (${rules.unreadStatus}).`;
  }
  return rules.pullRequest
    ? `A pull_request rule applies to ${rules.branch}.`
    : `No pull_request rule applies to ${rules.branch}.`;
}

/** What a refused installation tells the admin to do. */
function problemLinks(app: AppRecord, installationId: number): OutcomeLink[] {
  return [
    { label: "Installation settings on GitHub", href: installationSettingsUrl(app.owner, installationId) },
  ];
}

/**
 * Link the App's installation, once the admin has installed it on GitHub.
 * `installationId` is what GitHub's redirect said: a hint, which must be the
 * installation GitHub lists for the App.
 */
export async function finishLinking(input: unknown, ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  const parsed = FinishInputSchema.safeParse(input);
  const hint = parsed.success ? parsed.data?.installationId : undefined;
  if (!parsed.success || (hint !== undefined && !isGitHubId(hint))) {
    return refused("input", "That isn't an installation of the App.");
  }

  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      const app = state.app;
      if (!app) return refused("no-app", "Create the App first.");
      if (state.link) {
        return refused("linked", `This instance is already linked to ${fullName(state.link.repository)}.`);
      }

      const session = await appSession(app);
      const installations = await listInstallations(session);
      if (installations.length === 0) {
        return refused(
          "not-installed",
          `GitHub has no installation of ${app.name} yet. Install it, then finish linking.`,
          "info",
          [{ label: "Install on GitHub", href: installAppUrl(app.slug) }],
        );
      }
      if (installations.length > 1) {
        await audit(actor, "github.link.rejected", app, {
          reason: "more-than-one-installation",
          installationIds: installations.map((i) => i.id),
        });
        return refused(
          "more-than-one-installation",
          `${app.name} is installed on ${installations.length} accounts. A private App belongs on one: ` +
            "uninstall the others on GitHub.",
        );
      }
      const installation = installations[0];
      if (hint !== undefined && installation.id !== hint) {
        return refused(
          "not-this-installation",
          "GitHub doesn't list that installation for this App. Finish linking from this page.",
        );
      }
      if (installation.suspended_at) {
        return refused(
          "suspended",
          `The installation of ${app.name} is suspended on GitHub. Unsuspend it, then finish linking.`,
          "warning",
          problemLinks(app, installation.id),
        );
      }

      const listing = await countRepositories(session, installation.id);
      const verdict = judgeInstallation(app, installation, listing, null);
      if (!verdict.ok) {
        await audit(actor, "github.link.rejected", app, {
          reason: verdict.problem,
          detail: verdict.detail,
          installationId: installation.id,
        });
        return refused(
          verdict.problem,
          `Not linked. ${verdict.detail} On GitHub, choose "Only select repositories" and the one ` +
            "repository this instance is built from, then finish linking.",
          "danger",
          problemLinks(app, installation.id),
        );
      }

      const { record, rules } = await readLinked(session, installation.id, recordFrom(verdict.repository));
      const at = nowOf(ctx);
      const link: LinkRecord = {
        installationId: installation.id,
        repository: record,
        linkedAt: at.toISOString(),
        checkedAt: at.toISOString(),
        disabled: null,
      };
      await lease.assertHeld();
      if (!(await recordLink(link, ruleRecord(record, rules, at)))) {
        return refused("linked", "This instance was linked meanwhile. Reload the page.");
      }
      await audit(actor, "github.link", app, {
        installationId: installation.id,
        repositoryId: record.id,
        repository: fullName(record),
        defaultBranch: record.defaultBranch,
        fork: record.fork,
        parent: record.parent?.fullName ?? null,
        pullRequestRule: rules.pullRequest,
      });
      return {
        ok: true,
        message: `Linked to ${fullName(record)}. ${ruleSentence(rules)}`,
      };
    });
  } catch (err) {
    return fromError(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Every operation: the installation, checked again                            */
/* -------------------------------------------------------------------------- */

/** Why an operation couldn't use the link, as an error carrying what to tell the admin. */
export class GitHubLinkError extends Error {
  constructor(readonly outcome: Extract<GitHubOutcome, { ok: false }>) {
    super(outcome.message);
    this.name = "GitHubLinkError";
  }
}

/** Switch the link off for `problem`, audited the first time. */
async function switchOff(
  actor: AdminActor,
  app: AppRecord,
  link: LinkRecord,
  problem: LinkProblem,
  detail: string,
  at: Date,
): Promise<void> {
  let changed = false;
  await updateLink(link.installationId, (current) => {
    if (current.disabled) return null;
    changed = true;
    return { ...current, disabled: { at: at.toISOString(), reason: problem, detail } };
  });
  if (changed) {
    await audit(actor, "github.link.disable", app, {
      reason: problem,
      detail,
      installationId: link.installationId,
      repositoryId: link.repository.id,
      repository: fullName(link.repository),
    });
  }
}

/**
 * Read the installation again and judge it. On a widened one, the link is
 * switched off (audited) and a GitHubLinkError thrown; so are an uninstalled or
 * suspended one, without switching anything off. Returns the App's session and
 * GitHub's view of the linked repository.
 */
async function recheck(
  actor: AdminActor,
  app: AppRecord,
  link: LinkRecord,
  at: Date,
): Promise<{ session: AppSession; repository: ReturnType<typeof recordFrom> }> {
  const session = await appSession(app);
  let installation;
  try {
    installation = await readInstallation(session, link.installationId);
  } catch (err) {
    if (err instanceof GitHubError && err.failure === "not-found") {
      throw new GitHubLinkError(
        refused(
          "not-installed",
          `${app.name} is no longer installed on GitHub. Unlink, then create and install an App again to link.`,
        ),
      );
    }
    throw err;
  }
  if (installation.suspended_at) {
    throw new GitHubLinkError(
      refused(
        "suspended",
        `The installation of ${app.name} is suspended on GitHub. Unsuspend it, then check again.`,
        "warning",
        problemLinks(app, link.installationId),
      ),
    );
  }
  const listing = await countRepositories(session, link.installationId);
  const verdict = judgeInstallation(app, installation, listing, link.repository.id);
  if (!verdict.ok) {
    await switchOff(actor, app, link, verdict.problem, verdict.detail, at);
    throw new GitHubLinkError(
      refused(
        verdict.problem,
        `The link is off. ${verdict.detail} Narrow the installation to ${fullName(link.repository)} on ` +
          "GitHub, then check again, or unlink.",
        "danger",
        problemLinks(app, link.installationId),
      ),
    );
  }
  return { session, repository: recordFrom(verdict.repository) };
}

/**
 * Run `fn` with the linked repository, through a token of `shape` narrowed to
 * it and revoked when `fn` ends. The installation is checked again first,
 * which can switch the link off. Throws GitHubLinkError when the link can't be
 * used, with what to tell the admin.
 *
 * This is how proposals reach the repository (./propose.ts): "write" for a
 * proposal's writes, with `scope` naming the one folder they may touch
 * (./repository.ts guardWrite()), and "read" for everything that looks.
 */
export async function withLinkedRepository<T>(
  shape: TokenShape,
  actor: AdminActor,
  fn: (repo: LinkedRepository) => Promise<T>,
  ctx: { now?(): Date; scope?: WriteScope } = {},
): Promise<T> {
  const off = featureRefusal();
  if (off) throw new GitHubLinkError(off);
  if (shape === "write" && !ctx.scope) {
    throw new GitHubError("A write token needs a write scope. This is a bug in the caller.", "path");
  }
  const state = await readGitHubState();
  if (!state.app || !state.link) {
    throw new GitHubLinkError(refused("not-linked", "Link a repository on Admin > GitHub first.", "info"));
  }
  if (state.link.disabled) {
    throw new GitHubLinkError(
      refused(
        "disabled",
        `The GitHub link is off: ${state.link.disabled.detail} Check again on Admin > GitHub.`,
        "danger",
      ),
    );
  }
  const { app, link } = state;
  const { session, repository } = await recheck(actor, app, link, nowOf(ctx));
  if (
    repository.owner !== link.repository.owner ||
    repository.name !== link.repository.name ||
    repository.defaultBranch !== link.repository.defaultBranch
  ) {
    throw new GitHubLinkError(
      refused(
        "moved",
        `GitHub now lists the repository as ${fullName(repository)} with default branch ${repository.defaultBranch}. ` +
          "Check again on Admin > GitHub to record that.",
      ),
    );
  }
  const token = await mintRepositoryToken(session, link.installationId, link.repository.id, shape);
  try {
    return await fn(linkedRepository(link.repository, shape, token, shape === "write" ? ctx.scope : undefined));
  } finally {
    await revokeToken(token);
  }
}

/**
 * Whether a proposal may go ahead on the branch rule: a `pull_request` rule
 * was found on the default branch at the last read, or an admin confirmed
 * another protection. Browse reads it from what is stored; a proposal reads
 * the rule again first (./propose.ts).
 */
export function branchRuleSatisfied(
  state: Pick<GitHubState, "branchRule" | "override">,
): { ok: true; via: "rule" | "override" } | { ok: false } {
  if (state.branchRule?.pullRequest) return { ok: true, via: "rule" };
  if (state.override) return { ok: true, via: "override" };
  return { ok: false };
}

/* -------------------------------------------------------------------------- */
/*  Check again                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The admin's Check again: the installation, then the repository and its
 * default branch's rules. A repository renamed or given a new default branch
 * on GitHub, with the same id, is recorded (audited); a link switched off is
 * switched back on once every check passes (audited).
 */
export async function checkLink(ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      if (!state.app || !state.link) return refused("not-linked", "Nothing is linked yet.", "info");
      const { app, link } = state;
      const at = nowOf(ctx);
      const { session, repository } = await recheck(actor, app, link, at);

      // Same id, so the same repository: GitHub's current name and default
      // branch for it are recorded, and both reads below use them.
      const { record, rules } = await readLinked(session, link.installationId, repository);
      const moved =
        record.owner !== link.repository.owner ||
        record.name !== link.repository.name ||
        record.defaultBranch !== link.repository.defaultBranch;

      await lease.assertHeld();
      const wasOff = link.disabled;
      await updateLink(link.installationId, (current) => ({
        ...current,
        repository: record,
        checkedAt: at.toISOString(),
        disabled: null,
      }));
      await saveBranchRule(ruleRecord(record, rules, at));

      if (moved) {
        await audit(actor, "github.link.refresh", app, {
          repositoryId: record.id,
          from: { repository: fullName(link.repository), defaultBranch: link.repository.defaultBranch },
          to: { repository: fullName(record), defaultBranch: record.defaultBranch },
        });
      }
      if (wasOff) {
        await audit(actor, "github.link.enable", app, {
          repositoryId: record.id,
          repository: fullName(record),
          wasOffFor: wasOff.reason,
        });
      }
      const parts = [
        wasOff
          ? `The link is back on: the installation covers only ${fullName(record)}.`
          : moved
            ? `Recorded what GitHub calls the repository now: ${fullName(record)}, default branch ${record.defaultBranch}.`
            : `${fullName(record)} checks out.`,
        ruleSentence(rules),
      ];
      return { ok: true, message: parts.filter(Boolean).join(" ") };
    });
  } catch (err) {
    if (err instanceof GitHubLinkError) return err.outcome;
    return fromError(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Replace the private key                                                     */
/* -------------------------------------------------------------------------- */

const ReplaceInputSchema = z.object({ pem: z.string().max(20_000) });

/**
 * Store a private key the admin generated in the App's settings on GitHub,
 * once a JWT signed with it gets this App's id from GET /app. Audited with both
 * fingerprints, and the admin reminded to delete the old key on GitHub: GitHub
 * has no API to create or revoke an App's keys.
 */
export async function replacePrivateKey(input: unknown, ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  const parsed = ReplaceInputSchema.safeParse(input);
  if (!parsed.success) return refused("input", "Paste the private key, the whole .pem file.");

  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      const app = state.app;
      if (!app) return refused("no-app", "There's no App to replace a key for.");

      let key;
      try {
        key = parsePrivateKey(parsed.data.pem);
      } catch (err) {
        if (err instanceof PrivateKeyError) return refused("key", err.message);
        throw err;
      }
      const fingerprint = keyFingerprint(key);

      let answer;
      try {
        const { data } = await githubRequest("/app", { auth: { kind: "app", jwt: appJwt(app.id, key) } });
        answer = parseAnswer(AppSchema, data, "GET /app");
      } catch (err) {
        if (err instanceof GitHubError && (err.failure === "unauthorized" || err.failure === "not-found")) {
          await audit(actor, "github.app.key.replace.rejected", app, { reason: "refused", fingerprint });
          return refused(
            "key-refused",
            `GitHub doesn't accept that key for ${app.name}. Generate a private key in the App's settings ` +
              "and paste that file.",
            "warning",
            [{ label: "App settings on GitHub", href: appSettingsUrl(app.owner, app.slug) }],
          );
        }
        throw err;
      }
      if (answer.id !== app.id) {
        await audit(actor, "github.app.key.replace.rejected", app, {
          reason: "another-app",
          fingerprint,
          keyAppId: answer.id,
        });
        return refused(
          "another-app",
          `That key belongs to a different App (id ${answer.id}), not ${app.name} (id ${app.id}). Nothing changed.`,
        );
      }

      await lease.assertHeld();
      if (!(await replaceAppKey(app.id, sealPrivateKey(storedPem(key)), fingerprint))) {
        return refused("changed", "The App changed meanwhile. Reload the page.");
      }
      await audit(actor, "github.app.key.replace", app, {
        previousFingerprint: app.keyFingerprint,
        fingerprint,
      });
      const same = fingerprint === app.keyFingerprint;
      return {
        ok: true,
        message: same
          ? `Stored the key again, under the current GITHUB_APP_ENCRYPTION_KEY. Its fingerprint is ${fingerprint}.`
          : `Replaced the private key: this instance now uses ${fingerprint}. Delete the old key, ` +
            `${app.keyFingerprint}, in the App's settings on GitHub.`,
        links: [{ label: "App settings on GitHub", href: appSettingsUrl(app.owner, app.slug) }],
      };
    });
  } catch (err) {
    return fromError(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Unlink, and Forget                                                          */
/* -------------------------------------------------------------------------- */

/** More installations than a private App can have: something is wrong, so nothing is touched. */
const MAX_INSTALLATIONS = 5;

/**
 * Uninstall the App from GitHub, confirm GitHub lists no installation of it,
 * then forget the key, the ids and the link. When GitHub refuses, nothing here
 * is deleted.
 */
export async function unlink(ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      const app = state.app;
      if (!app) return refused("no-app", "Nothing is linked.", "info");
      const settings = { label: "App settings on GitHub", href: appSettingsUrl(app.owner, app.slug) };

      let session: AppSession;
      try {
        session = await appSession(app);
      } catch (err) {
        if (!(err instanceof KeyUnavailableError)) throw err;
        return refused(
          "key-unreadable",
          `${err.message} Without the key, the App can't be uninstalled from here, so nothing was deleted.`,
          "danger",
          [settings],
        );
      }

      let installations;
      try {
        installations = await listInstallations(session);
      } catch (err) {
        if (err instanceof GitHubError && err.failure === "unauthorized") {
          await audit(actor, "github.unlink.rejected", app, { reason: "key-refused" });
          return refused(
            "key-refused",
            "GitHub doesn't accept the App's private key, so it couldn't be uninstalled and nothing was deleted. " +
              "Replace the key and unlink again. If the App was deleted on GitHub, use Forget.",
            "danger",
            [settings],
          );
        }
        throw err;
      }
      if (installations.length > MAX_INSTALLATIONS) {
        return refused(
          "too-many",
          `${app.name} has ${installations.length} installations. Uninstall them on GitHub.`,
          "danger",
          [settings],
        );
      }

      const removed: number[] = [];
      for (const installation of installations) {
        await lease.assertHeld();
        try {
          await deleteInstallation(session, installation.id);
          removed.push(installation.id);
        } catch (err) {
          if (err instanceof GitHubError && err.failure === "not-found") continue;
          await audit(actor, "github.unlink.rejected", app, {
            reason: "uninstall-refused",
            installationId: installation.id,
            status: err instanceof GitHubError ? (err.status ?? null) : null,
          });
          if (!(err instanceof GitHubError)) throw err;
          return refused(
            "uninstall-refused",
            `GitHub refused to uninstall ${app.name} (${err.status ?? err.failure}), so nothing was deleted here. ` +
              "Try again, or uninstall it on GitHub and then unlink.",
            "danger",
            [settings],
          );
        }
      }

      const left = await listInstallations(session);
      if (left.length > 0) {
        await audit(actor, "github.unlink.rejected", app, {
          reason: "still-installed",
          installationIds: left.map((i) => i.id),
        });
        return refused(
          "still-installed",
          `GitHub still lists ${app.name} as installed, so nothing was deleted here. Try again in a moment.`,
          "danger",
          [settings],
        );
      }

      await lease.assertHeld();
      await forgetEverything();
      await audit(actor, "github.unlink", app, {
        installationIds: removed,
        recordedInstallationId: state.link?.installationId ?? null,
        repository: state.link ? fullName(state.link.repository) : null,
      });
      return {
        ok: true,
        message:
          `Uninstalled ${app.name} and forgot its key here. To finish, delete the App on GitHub, ` +
          "which deletes its keys too.",
        links: [settings],
      };
    });
  } catch (err) {
    return fromError(err);
  }
}

const ForgetInputSchema = z.object({ typedSlug: z.string().max(200) });

/**
 * Forget the App without uninstalling it: only when its key can't be used, by
 * this instance or by GitHub, so Unlink can't work. The slug has to be typed.
 */
export async function forgetApp(input: unknown, ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  const parsed = ForgetInputSchema.safeParse(input);
  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      const app = state.app;
      if (!app) return refused("no-app", "There's no App to forget.", "info");
      if (!parsed.success || parsed.data.typedSlug.trim() !== app.slug) {
        return refused("typed", `Type ${app.slug} to forget the App.`);
      }

      let why: "key-unreadable" | "key-refused";
      try {
        const session = await appSession(app);
        await githubRequest("/app", { auth: { kind: "app", jwt: session.jwt } });
        return refused(
          "key-works",
          `GitHub accepts the App's key, so unlink instead: that uninstalls ${app.name} first.`,
        );
      } catch (err) {
        if (err instanceof KeyUnavailableError) why = "key-unreadable";
        else if (err instanceof GitHubError && (err.failure === "unauthorized" || err.failure === "not-found")) {
          why = "key-refused";
        } else throw err;
      }

      await lease.assertHeld();
      await forgetEverything();
      await audit(actor, "github.app.forget", app, {
        why,
        recordedInstallationId: state.link?.installationId ?? null,
        repository: state.link ? fullName(state.link.repository) : null,
      });
      return {
        ok: true,
        message:
          `Forgot ${app.name} without uninstalling it. If it still exists on GitHub, delete it there: ` +
          "until then it may still be installed.",
        links: [{ label: "App settings on GitHub", href: appSettingsUrl(app.owner, app.slug) }],
      };
    });
  } catch (err) {
    return fromError(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  The branch rule's override                                                  */
/* -------------------------------------------------------------------------- */

const OverrideInputSchema = z.object({
  reason: z.enum(OVERRIDE_REASONS),
  typedRepository: z.string().max(300),
});

/**
 * An admin's confirmation that the default branch takes changes only through
 * pull requests by a protection the App can't see: classic branch protection,
 * or none possible on a private repository under GitHub Free. Needs the
 * repository's name typed. Proposals read it (branchRuleSatisfied(), ./propose.ts).
 */
export async function confirmBranchProtection(input: unknown, ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  const parsed = OverrideInputSchema.safeParse(input);
  if (!parsed.success) return refused("input", "Choose which applies.");
  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      if (!state.app || !state.link) return refused("not-linked", "Nothing is linked yet.", "info");
      const { app, link } = state;
      if (link.disabled) return refused("disabled", "The link is off. Check again first.");
      const name = fullName(link.repository);
      if (parsed.data.typedRepository.trim() !== name) return refused("typed", `Type ${name} to confirm.`);
      if (state.branchRule?.pullRequest) {
        return refused(
          "not-needed",
          `A pull_request rule already applies to ${state.branchRule.branch}, so nothing needs confirming.`,
          "info",
        );
      }
      await lease.assertHeld();
      await saveOverride({
        repositoryId: link.repository.id,
        reason: parsed.data.reason,
        at: nowOf(ctx).toISOString(),
        by: actor.email,
      });
      await audit(actor, "github.branch-rule.override", app, {
        reason: parsed.data.reason,
        repositoryId: link.repository.id,
        repository: name,
        branch: link.repository.defaultBranch,
      });
      return { ok: true, message: `Recorded: ${link.repository.defaultBranch} is protected another way.` };
    });
  } catch (err) {
    return fromError(err);
  }
}

/** Withdraw that confirmation. */
export async function withdrawBranchProtection(ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      if (!state.app) return refused("no-app", "Nothing is linked.", "info");
      await lease.assertHeld();
      if (!(await clearOverride())) return refused("none", "There was no confirmation to withdraw.", "info");
      await audit(actor, "github.branch-rule.override.clear", state.app, {
        repository: state.link ? fullName(state.link.repository) : null,
      });
      return { ok: true, message: "Withdrawn." };
    });
  } catch (err) {
    return fromError(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  The preview checklist                                                       */
/* -------------------------------------------------------------------------- */

const ChecklistInputSchema = z.object({ items: z.array(z.string()).max(10) });

/**
 * An admin's confirmation of what the App can't read: that no host builds
 * previews of the App's branches, and nothing else builds its pull requests
 * with secrets (PREVIEW_CHECKLIST in ./store.ts). Every item has to be ticked.
 * Proposals need it (./propose.ts). Audited.
 */
export async function confirmPreviewChecklist(input: unknown, ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  const parsed = ChecklistInputSchema.safeParse(input);
  const items = parsed.success ? new Set(parsed.data.items) : new Set<string>();
  if (!PREVIEW_CHECKLIST.every((item) => items.has(item))) {
    return refused("input", "Tick every item: each one is something the App can't check for you.");
  }
  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      if (!state.app || !state.link) return refused("not-linked", "Nothing is linked yet.", "info");
      const { app, link } = state;
      if (link.disabled) return refused("disabled", "The link is off. Check again first.");
      await lease.assertHeld();
      await savePreviewChecklist({
        repositoryId: link.repository.id,
        items: [...PREVIEW_CHECKLIST],
        at: nowOf(ctx).toISOString(),
        by: actor.email,
      });
      await audit(actor, "github.previews.confirm", app, {
        items: [...PREVIEW_CHECKLIST],
        repositoryId: link.repository.id,
        repository: fullName(link.repository),
      });
      return { ok: true, message: "Recorded: nothing else builds the App's branches." };
    });
  } catch (err) {
    return fromError(err);
  }
}

/** Withdraw that confirmation: proposals stop until it is confirmed again. */
export async function withdrawPreviewChecklist(ctx: LinkContext): Promise<GitHubOutcome> {
  const actor = await ctx.admin();
  const off = featureRefusal();
  if (off) return off;
  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      if (!state.app) return refused("no-app", "Nothing is linked.", "info");
      await lease.assertHeld();
      if (!(await clearPreviewChecklist())) return refused("none", "There was no confirmation to withdraw.", "info");
      await audit(actor, "github.previews.confirm.clear", state.app, {
        repository: state.link ? fullName(state.link.repository) : null,
      });
      return { ok: true, message: "Withdrawn. Proposals stay off until it is confirmed again." };
    });
  } catch (err) {
    return fromError(err);
  }
}
