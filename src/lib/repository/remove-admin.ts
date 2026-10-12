/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Remove button's preview and removal, on Admin > Apps, Connectors and
 * Themes: the work behind the server actions in ./remove-actions.ts, which pass
 * in the signed-in admin and the facts about this deployment, so a test can
 * pass its own.
 *
 * Each one, in this order:
 *
 *   1. Requires an admin (`admin()`, which is requireAdmin()), before it reads
 *      anything else. A server action is reachable by anyone who can name it,
 *      not only by the page that shows the button (docs/security-architecture.md §9).
 *   2. Refuses on a built deployment, which has no checkout to change. That is
 *      how a deployment works rather than a fault, so it is said as information.
 *   3. Calls ./remove.ts: the preview reads the checkout without a lock; the
 *      removal takes both locks, checks everything again, and writes the audit
 *      row, naming the admin, with `via: "button"`.
 *   4. Returns what happened as a value, since a thrown error reaches the
 *      browser as an opaque digest in production.
 *
 * The second button, "Remove code and delete this checkout's data", asks for
 * the name typed, which is checked before anything is removed. Once the code is
 * removed, it deletes the data with the same checks as Delete data
 * (./delete-data-admin.ts): refused while another build that uses this database
 * still has it. A refusal there leaves the removal done and the data kept.
 */

import { z } from "zod";
import { recordAdminAction, type AdminActor } from "../apps/admin-audit";
import { BUILT_DEPLOYMENT_REMOVE_NOTICE } from "../platform/build";
import { CheckoutLockHeldError } from "../platform/checkout-lock";
import { LockUnavailableError } from "../platform/lock";
import { safeErrorMessage } from "../safe-error";
import { EXTENSION_NAME_PATTERN } from "./backup";
import { isDataKind, type DataDeleteOutcome, type DataKind, type DataPreview } from "./delete-data-outcomes";
import { checkoutRoot } from "./install";
import { LOCKED_MESSAGE } from "./pending-admin";
import type { Refusal } from "./pending-outcomes";
import { sourceHost } from "./provenance";
import { describeRemoveFailure, planRemoval, removeExtension, type RemovalPlan } from "./remove";
import type { InstalledFrom, PreviewOutcome, RemoveOutcome } from "./remove-outcomes";
import { ExtensionKindSchema, KIND_SEGMENT } from "./types";

export interface RemoveContext {
  /** The signed-in admin, or a throw: requireAdmin(). Called first. */
  admin(): Promise<AdminActor>;
  /** isBuiltDeployment(). */
  builtDeployment(): boolean;
  /** revalidatePath(). */
  revalidate(path: string, type?: "layout" | "page"): void;
  /** Whether this server stops serving a removed extension without a rebuild: `next dev`. */
  servesWithoutRebuild(): boolean;
  /**
   * What deleting its data along with its code would delete, and whether that
   * would be refused: previewDataBeforeRemoval(). Without it, or when it
   * answers null, the dialog offers only to keep the data.
   */
  previewData?(kind: DataKind, slug: string): Promise<DataPreview | null>;
  /** Delete its data right after its code was removed: deleteDataAfterRemoval(). */
  deleteData?(kind: DataKind, slug: string, actor: AdminActor): Promise<DataDeleteOutcome>;
  /** Tests: the checkout. This one otherwise. */
  root?: string;
  /** Tests: a stand-in for the registry generator. */
  generator?: string;
}

const TargetSchema = z.object({ kind: ExtensionKindSchema, slug: z.string().regex(EXTENSION_NAME_PATTERN) });

/** The removal's input: the target, and whether to delete its data too, with its name typed. */
const RemovalSchema = TargetSchema.extend({
  deleteData: z.boolean().optional(),
  typedSlug: z.string().optional(),
});

const notAnExtension = (): Refusal => ({
  ok: false,
  code: "not-installed",
  message: "That isn't an extension in this checkout.",
  tone: "warning",
});

const builtDeployment = (): Refusal => ({
  ok: false,
  code: "unsupported-environment",
  message: BUILT_DEPLOYMENT_REMOVE_NOTICE,
  tone: "info",
});

/** Any failure of the preview or the removal, as the admin pages say it. */
export function removalRefusal(err: unknown): Refusal {
  // Someone else holds a lock, so nothing happened yet: neutral, and Try again.
  if (err instanceof LockUnavailableError) {
    return { ok: false, code: "locked", message: LOCKED_MESSAGE, tone: "neutral" };
  }
  if (err instanceof CheckoutLockHeldError) {
    return { ok: false, code: "locked", message: err.message, tone: "neutral" };
  }
  const failure = describeRemoveFailure(err);
  if (failure.code === "unknown") {
    // Its words can name this machine's paths; the log keeps them.
    console.error("[remove] unexpected failure:", err);
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

function installedFrom(installed: RemovalPlan["installed"]): InstalledFrom | null {
  return installed ? { host: sourceHost(installed.source), version: installed.version } : null;
}

/** What removing it would do, and what stands in its way. Reads only. */
export async function previewForButton(input: unknown, ctx: RemoveContext): Promise<PreviewOutcome> {
  await ctx.admin();
  const target = TargetSchema.safeParse(input);
  if (!target.success) return notAnExtension();
  if (ctx.builtDeployment()) return builtDeployment();
  const { kind, slug } = target.data;

  let plan: RemovalPlan;
  try {
    plan = await planRemoval(kind, slug, ctx.root ?? checkoutRoot());
  } catch (err) {
    return removalRefusal(err);
  }
  // Only when it can be removed, and only for the kinds that keep data.
  const data =
    plan.blockers.length === 0 && isDataKind(kind) && ctx.previewData ? await ctx.previewData(kind, slug) : null;
  return {
    ok: true,
    preview: {
      kind,
      slug,
      name: plan.name,
      path: plan.path,
      installed: installedFrom(plan.installed),
      blockers: plan.blockers,
      warnings: plan.warnings,
      pending: plan.pending,
      command: `npm run remove -- ${kind}/${slug}`,
      data,
    },
  };
}

/**
 * Remove its code from this checkout, and with `deleteData` and the name typed,
 * its data from this checkout's database after it. Refused, without a lock, on
 * a built deployment, audited as `<kind>.remove.rejected`, as removal itself
 * audits every refusal.
 */
export async function removeFromButton(input: unknown, ctx: RemoveContext): Promise<RemoveOutcome> {
  const actor = await ctx.admin();
  const target = RemovalSchema.safeParse(input);
  if (!target.success) return notAnExtension();
  const { kind, slug } = target.data;
  const deleteData = target.data.deleteData === true;

  // Before anything is removed: deleting data is only ever what was asked for.
  if (deleteData) {
    if (!isDataKind(kind)) {
      return { ok: false, code: "no-data", message: "A theme holds no data. Nothing was removed.", tone: "info" };
    }
    if (!ctx.deleteData) {
      return {
        ok: false,
        code: "unavailable",
        message: "Deleting data isn't available here. Nothing was removed.",
        tone: "info",
      };
    }
    if ((target.data.typedSlug ?? "").trim() !== slug) {
      return {
        ok: false,
        code: "not-confirmed",
        message: `Type ${slug} to delete its data too. Nothing was removed.`,
        tone: "warning",
      };
    }
  }

  if (ctx.builtDeployment()) {
    await recordAdminAction(actor, {
      action: `${kind}.remove.rejected`,
      targetType: kind,
      targetId: slug,
      details: { via: "button", reason: "unsupported-environment", message: BUILT_DEPLOYMENT_REMOVE_NOTICE },
    });
    return builtDeployment();
  }

  let result: Awaited<ReturnType<typeof removeExtension>>;
  try {
    result = await removeExtension(kind, slug, {
      actor,
      via: "button",
      root: ctx.root,
      generator: ctx.generator,
      notice: (message) => console.warn(`[remove] ${message}`),
    });
  } catch (err) {
    return removalRefusal(err);
  }

  // Its code is gone. Its data next, when asked: a refusal leaves it kept, and
  // the removal stands, so nothing here may turn into a failed removal.
  let data: DataDeleteOutcome | null = null;
  if (deleteData && isDataKind(kind) && ctx.deleteData) {
    try {
      data = await ctx.deleteData(kind, slug, actor);
    } catch (err) {
      console.error("[remove] deleting the data after the removal failed:", err);
      data = {
        ok: false,
        code: "unknown",
        message: "Its data couldn't be deleted, and nothing in the database was changed. The server log says why.",
        tone: "danger",
      };
    }
  }

  ctx.revalidate(`/admin/${KIND_SEGMENT[kind]}`);
  // The theme is stamped on <html> in the root layout, and the one applied may
  // be the one that went.
  if (kind === "theme") ctx.revalidate("/", "layout");
  return {
    ok: true,
    result: {
      kind,
      slug,
      name: result.name,
      path: result.path,
      installed: installedFrom(result.installed),
      warnings: result.warnings,
      discardedPending: result.discardedPending,
      servesNow: ctx.servesWithoutRebuild(),
      handBack: result.handBack,
      data,
    },
  };
}
