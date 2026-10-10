/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * The Scheduled Jobs admin page's actions: Run now, a job's Enable and
 * Disable, and Start and Stop tick for the whole scheduler.
 *
 * Each is a directly-invocable POST endpoint, so each calls `requireAdmin`
 * itself (docs/security-architecture.md §9). Each is audited, as activating an
 * app is (§28): who ran a job by hand, who paused one, and who stopped every
 * job at once are the questions asked afterwards.
 */

import { revalidatePath } from "next/cache";
import { appRegistry } from "@/generated/app-registry";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { runJobNow, setSchedulerEnabled } from "@/lib/apps/scheduler";
import { createServiceClient } from "@/lib/db/server";

const PAGE = "/admin/scheduled-jobs";

/**
 * Run one job now. The handler runs inline, up to the scheduler's job timeout,
 * so the refreshed page shows its new status or error. Refused here, not only
 * on the button, for an app that is not active, and for a job a live run
 * already holds: `runJobNow` checks both.
 */
export async function runJobNowAction(formData: FormData): Promise<void> {
  const appSlug = String(formData.get("appSlug") ?? "");
  const jobName = String(formData.get("jobName") ?? "");

  const session = await requireReadOnlySession();
  const admin = await requireAdmin(session);

  await runJobNow(appSlug, jobName, {
    // Recorded as the run starts, so a refused run leaves no row and a long
    // one leaves its row even if this request is cut short.
    onStart: () =>
      recordAdminAction(
        { id: admin.id, email: admin.email },
        {
          action: "app.job.run",
          targetType: "app",
          targetId: appSlug,
          details: { job: jobName },
        },
      ),
  });

  revalidatePath(PAGE);
}

/**
 * Enable or disable one job, which pauses it without a redeploy. The tick skips
 * a disabled job; Run now still runs it.
 */
export async function setJobEnabledAction(formData: FormData): Promise<void> {
  const appSlug = String(formData.get("appSlug") ?? "");
  const jobName = String(formData.get("jobName") ?? "");
  const enabled = formData.get("enabled") === "true";

  const session = await requireReadOnlySession();
  const admin = await requireAdmin(session);

  // Look up the cadence from the registry so a not-yet-synced row can still
  // be toggled — the upsert must supply exactly one cadence (cron or
  // interval) to satisfy the check constraint.
  const app = appRegistry.find((a) => a.slug === appSlug);
  const schedule = app?.schedules?.find((s) => s.name === jobName);
  if (!schedule) return;

  const { error } = await createServiceClient()
    .from("app_scheduled_jobs")
    .upsert(
      {
        app_slug: appSlug,
        job_name: jobName,
        interval_minutes: schedule.everyMinutes ?? null,
        cron: schedule.cron ?? null,
        timezone: schedule.timezone ?? null,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "app_slug,job_name" },
    );
  if (error) {
    throw new Error(`Failed to update ${appSlug}/${jobName}: ${error.message}`);
  }

  await recordAdminAction(
    { id: admin.id, email: admin.email },
    {
      action: enabled ? "app.job.enable" : "app.job.disable",
      targetType: "app",
      targetId: appSlug,
      details: { job: jobName },
    },
  );

  revalidatePath(PAGE);
}

/**
 * Start or stop the tick: the durable switch for every job at once. While it
 * is stopped, `runDueJobs()` skips every tick on every replica, and Run now
 * still runs a job.
 */
export async function setSchedulerEnabledAction(
  formData: FormData,
): Promise<void> {
  const enabled = formData.get("enabled") === "true";

  const session = await requireReadOnlySession();
  const admin = await requireAdmin(session);

  await setSchedulerEnabled(enabled);

  await recordAdminAction(
    { id: admin.id, email: admin.email },
    { action: enabled ? "scheduler.start" : "scheduler.stop" },
  );

  revalidatePath(PAGE);
}
