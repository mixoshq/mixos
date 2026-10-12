/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Delete data from the admin pages: **Delete data…** under Not in this build
 * on Admin > Apps and Admin > Connectors, and the Remove dialog's "Remove code
 * and delete this checkout's data". The work behind the server actions in
 * ./delete-data-actions.ts and ./remove-actions.ts, which pass in the
 * signed-in admin and the facts about this server, so a test can pass its own.
 *
 * Each one, in this order:
 *
 *   1. Requires an admin (`admin()`, which is requireAdmin()), before it reads
 *      anything else. A server action is reachable by anyone who can name it
 *      (docs/security-architecture.md §9).
 *   2. Checks what it was given: a kind that keeps data, a name, and, to
 *      delete, the name typed again.
 *   3. Calls ./delete-data.ts, which decides from the database and deletes in
 *      one transaction, auditing `<kind>.data.delete`. A refusal is audited
 *      here, as `<kind>.data.delete.rejected` with the reason.
 *   4. Returns what happened as a value, since a thrown error reaches the
 *      browser as an opaque digest in production.
 */

import { z } from "zod";
import { recordAdminAction, type AdminActor } from "../apps/admin-audit";
import type { DatabaseLocation } from "../db/locality";
import { safeErrorMessage } from "../safe-error";
import { EXTENSION_NAME_PATTERN } from "./backup";
import {
  asRefusal,
  DataRefusalError,
  deleteExtensionData,
  previewExtensionData,
  type DataCheckOptions,
} from "./delete-data";
import type { DataDeleteOutcome, DataKind, DataPreview, DataPreviewOutcome } from "./delete-data-outcomes";
import { describeHosts, type Refusal } from "./pending-outcomes";

export interface DataContext {
  /** The signed-in admin, or a throw: requireAdmin(). Called first. */
  admin(): Promise<AdminActor>;
  /** Whether the build serving this instance carries `kind`/`slug`. */
  inThisBuild(kind: DataKind, slug: string): boolean;
  /** This server's key in platform_builds_seen: thisBuildKey(). */
  ownBuildKey(): string | null;
}

/** What Delete data needs to know right after Remove, in the same request. */
export interface AfterRemovalContext {
  /** Whether this server stops serving a removed extension without a rebuild: `next dev`. */
  servesWithoutRebuild(): boolean;
  /** thisDatabase(). */
  database(): DatabaseLocation;
  /** Whether the registry the generator just wrote still lists it: listedInRegistry(). */
  listedInRegistry(kind: DataKind, slug: string): Promise<boolean>;
  /** This server's key in platform_builds_seen: thisBuildKey(). */
  ownBuildKey(): string | null;
}

const TargetSchema = z.object({
  kind: z.enum(["app", "connector"]),
  slug: z.string().regex(EXTENSION_NAME_PATTERN),
});

const notFound = (): Refusal => ({
  ok: false,
  code: "not-found",
  message: "That isn't an app or a connector this database keeps data for.",
  tone: "warning",
});

/** Any failure, as the admin pages say it. */
export function dataRefusal(err: unknown): Refusal {
  if (err instanceof DataRefusalError) return asRefusal(err);
  // Its words can name this database's objects or this machine's paths; the log keeps them.
  console.error("[delete-data] unexpected failure:", err);
  return {
    ok: false,
    code: "unknown",
    message: safeErrorMessage(err, "It couldn't be deleted, and nothing was changed. The server log says why."),
    tone: "danger",
  };
}

async function auditRefusal(
  actor: AdminActor,
  kind: DataKind,
  slug: string,
  refusal: Refusal,
  afterRemoval: boolean,
): Promise<void> {
  await recordAdminAction(actor, {
    action: `${kind}.data.delete.rejected`,
    targetType: kind,
    targetId: slug,
    details: {
      via: "button",
      ...(afterRemoval ? { afterRemoval: true } : {}),
      reason: refusal.code,
      // Never the words of an error nothing here expected.
      message: refusal.code === "unknown" ? "An unexpected error stopped it." : refusal.message,
    },
  });
}

/** What deleting its data would delete, and whether it would be refused now. Reads only. */
export async function previewDataForButton(input: unknown, ctx: DataContext): Promise<DataPreviewOutcome> {
  await ctx.admin();
  const target = TargetSchema.safeParse(input);
  if (!target.success) return notFound();
  const { kind, slug } = target.data;
  try {
    const preview = await previewExtensionData(kind, slug, {
      inServingBuild: ctx.inThisBuild(kind, slug),
      ownBuildKey: ctx.ownBuildKey(),
    });
    return { ok: true, preview };
  } catch (err) {
    return dataRefusal(err);
  }
}

/**
 * Delete its data, once the admin has typed its name. The page isn't
 * revalidated here: the entry would leave the list, and the dialog showing the
 * result with it. The dialog refreshes the page when it closes.
 */
export async function deleteDataFromButton(input: unknown, ctx: DataContext): Promise<DataDeleteOutcome> {
  const actor = await ctx.admin();
  const target = TargetSchema.extend({ typedSlug: z.string() }).safeParse(input);
  if (!target.success) return notFound();
  const { kind, slug, typedSlug } = target.data;
  if (typedSlug.trim() !== slug) {
    return { ok: false, code: "not-confirmed", message: `Type ${slug} to delete its data.`, tone: "warning" };
  }

  try {
    const result = await deleteExtensionData(kind, slug, {
      actor,
      inServingBuild: ctx.inThisBuild(kind, slug),
      ownBuildKey: ctx.ownBuildKey(),
    });
    return { ok: true, result };
  } catch (err) {
    const refusal = dataRefusal(err);
    await auditRefusal(actor, kind, slug, refusal, false);
    return refusal;
  }
}

/**
 * What a checkout's database says about deleting `kind`/`slug`'s data along
 * with its code, before the Remove dialog asks: the same rules as
 * deleteDataAfterRemoval(), as if the removal had happened. Null when the
 * database can't be read, so the dialog offers only to keep the data.
 */
export async function previewDataBeforeRemoval(
  kind: DataKind,
  slug: string,
  ctx: AfterRemovalContext,
): Promise<DataPreview | null> {
  try {
    const preview = await previewExtensionData(kind, slug, afterRemovalChecks(ctx, false));
    if (!ctx.servesWithoutRebuild() && !preview.refusal) {
      return { ...preview, refusal: stillServed(slug) };
    }
    return preview;
  } catch (err) {
    console.error("[delete-data] couldn't read what this checkout keeps:", err);
    return null;
  }
}

function afterRemovalChecks(ctx: AfterRemovalContext, inServingBuild: boolean): DataCheckOptions {
  const database = ctx.database();
  return {
    inServingBuild,
    ownBuildKey: ctx.ownBuildKey(),
    afterRemoval: { localDatabase: database.local, hosts: describeHosts(database) },
  };
}

function stillServed(slug: string): Refusal {
  return {
    ok: false,
    code: "still-served",
    message:
      `This server runs a production build of this checkout, which serves ${slug} until \`npm run build\` ` +
      "and a restart. Delete its data after that, under Not in this build.",
    tone: "info",
  };
}

/**
 * Delete `kind`/`slug`'s data right after the Remove button removed its code,
 * in the same request, with the same checks as Delete data. The build that
 * matters is the registry the generator just wrote, which `next dev` serves
 * from the next request; on a local database the removal counts as the release
 * step's mark (./delete-data.ts). The caller has required an admin, and the
 * name typed, before removing anything.
 */
export async function deleteDataAfterRemoval(
  kind: DataKind,
  slug: string,
  actor: AdminActor,
  ctx: AfterRemovalContext,
): Promise<DataDeleteOutcome> {
  let refusal: Refusal;
  if (!ctx.servesWithoutRebuild()) {
    refusal = stillServed(slug);
  } else {
    try {
      const result = await deleteExtensionData(kind, slug, {
        actor,
        ...afterRemovalChecks(ctx, await ctx.listedInRegistry(kind, slug)),
      });
      return { ok: true, result };
    } catch (err) {
      refusal = dataRefusal(err);
    }
  }
  await auditRefusal(actor, kind, slug, refusal, true);
  return refusal;
}
