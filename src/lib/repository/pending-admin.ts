/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review, Register, Discard and "Activate in this checkout" from the admin
 * pages: the work behind the server actions in ./pending-actions.ts, which
 * pass in the signed-in admin and the facts about this deployment, so a test
 * can pass its own.
 *
 * Each one, in this order:
 *
 *   1. Requires an admin (`admin()`, which is requireAdmin()), before it reads
 *      anything else. A server action is reachable by anyone who can name it,
 *      not only by the page that shows the button (docs/security-architecture.md §9).
 *   2. Refuses on a built deployment, which has no checkout to change. That is
 *      how a deployment works rather than a fault, so it is said as information.
 *   3. Calls ./register.ts, which takes both locks, checks everything again,
 *      and writes the audit row, naming the admin, with `via: "button"`.
 *   4. Returns what happened as a value. A thrown error reaches the browser as
 *      an opaque digest in production, and "another administrator is
 *      registering" or "its files changed since install" are what the admin
 *      needs to read (see ./actions.ts).
 */

import { z } from "zod";
import { recordAdminAction, type AdminActor } from "../apps/admin-audit";
import type { DatabaseLocation } from "../db/locality";
import { BUILT_DEPLOYMENT_NOTICE } from "../platform/build";
import { CheckoutLockHeldError } from "../platform/checkout-lock";
import { LockUnavailableError } from "../platform/lock";
import { safeErrorMessage } from "../safe-error";
import { fetchInstallManifest, repositoryBaseUrl } from "./client";
import { checkoutRoot } from "./install";
import { liveLocation, type PendingKind } from "./pending";
import { describeRegisterFailure, discardPending, registerPending } from "./register";
import {
  MAX_LINE_CHARS,
  ReviewError,
  migrationCount,
  reviewPendingInstall,
  shownText,
  type PendingReview,
} from "./review";
import {
  describeHosts,
  type ActivateOutcome,
  type Activation,
  type DiscardOutcome,
  type ListingFacts,
  type RegisterOutcome,
  type Refusal,
  type ReviewOutcome,
} from "./pending-outcomes";
import { CONTENT_HASH_PATTERN, KIND_SEGMENT, SlugSchema } from "./types";

/** What a lock held by someone else reads as, from the database's register lock. */
export const LOCKED_MESSAGE =
  "Another administrator is installing, registering or removing an extension. Try again in a moment.";

/* -------------------------------------------------------------------------- */
/*  What each action is given                                                   */
/* -------------------------------------------------------------------------- */

export interface PendingContext {
  /** The signed-in admin, or a throw: requireAdmin(). Called first. */
  admin(): Promise<AdminActor>;
  /** isBuiltDeployment(). */
  builtDeployment(): boolean;
  /** revalidatePath(). */
  revalidate(path: string): void;
  /** Tests: the checkout. This one otherwise. */
  root?: string;
  /** Tests: a stand-in for the registry generator. */
  generator?: string;
}

export interface ReviewContext extends PendingContext {
  /** The publisher's claims, from the catalogue: listingFacts(). */
  listing(review: PendingReview): Promise<ListingFacts>;
}

export interface RegisterContext extends PendingContext {
  /** thisDatabase(). */
  database(): DatabaseLocation;
  /** Whether this server runs what is registered without a rebuild: `next dev`. */
  servesWithoutRebuild(): boolean;
}

export interface ActivateContext {
  admin(): Promise<AdminActor>;
  builtDeployment(): boolean;
  database(): DatabaseLocation;
  /** Whether this server's registry carries the app. */
  inThisBuild(slug: string): boolean;
  /** Turn it on, with activation's own checks and audit row: setAppActiveAction(). */
  activate(slug: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Shared                                                                      */
/* -------------------------------------------------------------------------- */

const TargetSchema = z.object({ kind: z.enum(["app", "connector"]), slug: SlugSchema });

const RegisterInputSchema = TargetSchema.extend({
  /** What the admin reviewed: Register refuses a pending install whose record says otherwise. */
  reviewedFilesHash: z.string().regex(CONTENT_HASH_PATTERN),
});

const notPending = (what: string): Refusal => ({
  ok: false,
  code: "not-pending",
  message: `That isn't a pending install to ${what}.`,
  tone: "warning",
});

const builtDeployment = (): Refusal => ({
  ok: false,
  code: "unsupported-environment",
  message: BUILT_DEPLOYMENT_NOTICE,
  tone: "info",
});

/** Any failure of Register or Discard, as the admin pages say it. */
export function refusalFor(err: unknown): Refusal {
  // Someone else holds a lock, so nothing happened yet: neutral, and Try again.
  if (err instanceof LockUnavailableError) {
    return { ok: false, code: "locked", message: LOCKED_MESSAGE, tone: "neutral" };
  }
  // The checkout lock: its message names the holder, such as the registry
  // generator `npm run dev` started.
  if (err instanceof CheckoutLockHeldError) {
    return { ok: false, code: "locked", message: err.message, tone: "neutral" };
  }
  const failure = describeRegisterFailure(err);
  if (failure.code === "unknown") {
    // Its words can name this machine's paths; the log keeps them.
    console.error("[register] unexpected failure:", err);
    return {
      ok: false,
      code: "unknown",
      message: safeErrorMessage(err, "Something unexpected stopped it. The server log says what."),
      tone: "danger",
    };
  }
  return {
    ok: false,
    code: failure.code,
    message: failure.message,
    detail: failure.detail,
    tone: failure.code === "unsupported-environment" ? "info" : "warning",
  };
}

/** Where the app is activated after Register, from where its database is and what this server runs. */
export function activationFor(kind: PendingKind, database: DatabaseLocation, servesNow: boolean): Activation {
  if (kind !== "app") return "none";
  if (!database.local) return "elsewhere";
  return servesNow ? "here" : "after-rebuild";
}

/* -------------------------------------------------------------------------- */
/*  Review                                                                      */
/* -------------------------------------------------------------------------- */

/** What will run, from the pending install, and what the catalogue claims for it. */
export async function reviewForButton(input: unknown, ctx: ReviewContext): Promise<ReviewOutcome> {
  await ctx.admin();
  const target = TargetSchema.safeParse(input);
  if (!target.success) return notPending("review");
  if (ctx.builtDeployment()) return builtDeployment();

  let review: PendingReview;
  try {
    review = reviewPendingInstall(ctx.root ?? checkoutRoot(), target.data.kind, target.data.slug);
  } catch (err) {
    if (err instanceof ReviewError) {
      return { ok: false, code: "not-pending", message: err.message, tone: "warning" };
    }
    throw err;
  }
  return { ok: true, review, listing: await ctx.listing(review) };
}

/**
 * The publisher's claims for the installed version, from the catalogue it was
 * installed from. Never throws: the review stands without them, and says why
 * they're missing.
 *
 * The link to the source isn't asked for: the review builds it from the
 * pending install's own record, which names the repository and the commit
 * install downloaded and verified, rather than what the listing says now.
 */
export async function listingFacts(review: PendingReview): Promise<ListingFacts> {
  const { kind, slug } = review;
  const { source, version, commitSha } = review.release;
  let origin: string;
  try {
    origin = repositoryBaseUrl();
  } catch (err) {
    return { state: "unavailable", origin: source, message: err instanceof Error ? err.message : String(err) };
  }
  if (origin !== source) {
    return {
      state: "unavailable",
      origin: source,
      message:
        `It was installed from ${source}, and this instance now uses ${origin}, so the ` +
        `publisher's claims aren't shown. Read the code in ${review.folder}/.`,
    };
  }

  let manifest: Awaited<ReturnType<typeof fetchInstallManifest>>;
  try {
    manifest = await fetchInstallManifest(kind, slug, version);
  } catch (err) {
    return {
      state: "unavailable",
      origin,
      message:
        `${origin} couldn't be asked for the publisher's claims ` +
        `(${err instanceof Error ? err.message : String(err)}). Read the code in ${review.folder}/.`,
    };
  }
  const claims = manifest.permissions.map((p) => ({
    scope: shownText(p.scope),
    reason: shownText(p.reason, MAX_LINE_CHARS),
  }));
  const note =
    manifest.commitSha !== commitSha
      ? `${origin} now lists commit ${manifest.commitSha.slice(0, 12)} for ${version}, not the ` +
        `${commitSha.slice(0, 12)} installed here. The claims are for the version, and the source link ` +
        `is to what was installed.`
      : null;
  return { state: "ok", origin, claims, note };
}

/* -------------------------------------------------------------------------- */
/*  Register                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Register what the admin reviewed. Refused, without a lock, on a built
 * deployment, audited as `<kind>.register.rejected`, as Register itself audits
 * every refusal.
 */
export async function registerFromButton(input: unknown, ctx: RegisterContext): Promise<RegisterOutcome> {
  const actor = await ctx.admin();
  const parsed = RegisterInputSchema.safeParse(input);
  if (!parsed.success) return notPending("register");
  const { kind, slug, reviewedFilesHash } = parsed.data;

  if (ctx.builtDeployment()) {
    await recordAdminAction(actor, {
      action: `${kind}.register.rejected`,
      targetType: kind,
      targetId: slug,
      details: { via: "button", reason: "unsupported-environment", message: BUILT_DEPLOYMENT_NOTICE },
    });
    return builtDeployment();
  }

  const root = ctx.root ?? checkoutRoot();
  let result: Awaited<ReturnType<typeof registerPending>>;
  try {
    result = await registerPending(kind, slug, {
      actor,
      via: "button",
      root,
      generator: ctx.generator,
      reviewedFilesHash,
      notice: (message) => console.warn(`[register] ${message}`),
    });
  } catch (err) {
    return refusalFor(err);
  }

  ctx.revalidate(`/admin/${KIND_SEGMENT[kind]}`);
  const database = ctx.database();
  const servesNow = ctx.servesWithoutRebuild();
  return {
    ok: true,
    result: {
      kind,
      slug,
      version: result.version,
      gitTag: result.gitTag,
      commitSha: result.commitSha,
      installPath: result.installPath,
      deferredChecked: result.deferred.length,
      migrations: kind === "app" ? migrationCount(liveLocation(root, kind, slug).dir) : 0,
      servesNow,
      database,
      activation: activationFor(kind, database, servesNow),
      handBack: result.handBack,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Discard                                                                     */
/* -------------------------------------------------------------------------- */

/** Delete a pending install, folder and record, under both locks. Audited by Discard. */
export async function discardFromButton(input: unknown, ctx: PendingContext): Promise<DiscardOutcome> {
  const actor = await ctx.admin();
  const parsed = TargetSchema.safeParse(input);
  if (!parsed.success) return notPending("discard");
  if (ctx.builtDeployment()) return builtDeployment();
  const { kind, slug } = parsed.data;

  try {
    const result = await discardPending(kind, slug, {
      actor,
      via: "button",
      root: ctx.root,
      generator: ctx.generator,
      notice: (message) => console.warn(`[register] ${message}`),
    });
    ctx.revalidate(`/admin/${KIND_SEGMENT[kind]}`);
    return { ok: true, pendingPath: result.pendingPath };
  } catch (err) {
    return refusalFor(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Activate in this checkout                                                   */
/* -------------------------------------------------------------------------- */

/** Activation's own refusal, which names the connector to configure: safe to show as it is. */
const CONNECTOR_REFUSAL = /^Configure .+ before activating this app\.$/;

/**
 * Turn a just-registered app on in this checkout's database: only when that
 * database is local, so it can't turn the app on for other instances that
 * share it. Then the same checks and audit row as Activate on Admin > Apps.
 */
export async function activateFromButton(input: unknown, ctx: ActivateContext): Promise<ActivateOutcome> {
  await ctx.admin();
  const parsed = z.object({ slug: SlugSchema }).safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "not-found", message: "That isn't an app in this checkout.", tone: "warning" };
  }
  const { slug } = parsed.data;

  if (ctx.builtDeployment()) {
    return {
      ok: false,
      code: "unsupported-environment",
      message: "This deployment runs a build, so there's no checkout here to activate it in. Activate it in Admin > Apps.",
      tone: "info",
    };
  }
  const database = ctx.database();
  if (!database.local) {
    return {
      ok: false,
      code: "shared-database",
      message:
        `This checkout's database is on ${describeHosts(database)}, which other instances may use too, ` +
        `so activating ${slug} here would turn it on for all of them. Activate it in Admin > Apps on ` +
        "the instance that serves it.",
      tone: "info",
    };
  }
  if (!ctx.inThisBuild(slug)) {
    return {
      ok: false,
      code: "not-in-this-build",
      message:
        `This server was built before ${slug} was registered, so it doesn't run it yet. Rebuild and ` +
        "restart it, then activate it in Admin > Apps.",
      tone: "info",
    };
  }

  try {
    await ctx.activate(slug);
  } catch (err) {
    const said = err instanceof Error && CONNECTOR_REFUSAL.test(err.message);
    if (!said) console.error(`[register] activating ${slug} failed:`, err);
    return {
      ok: false,
      code: "refused",
      message: said ? (err as Error).message : safeErrorMessage(err, "It couldn't be activated. The server log says why."),
      tone: "warning",
    };
  }
  return { ok: true, slug };
}
