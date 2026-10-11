/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NextResponse } from "next/server";
import { appRegistry } from "@/generated/app-registry";
import { hasAppGrant } from "@/lib/apps/access";
import { checkAppGate, type AppGate } from "@/lib/apps/app-gate";
import type { AppManifest } from "@/lib/apps/types";

/**
 * Which apps a signed-in user's analytics events are recorded for: the two
 * ingestion routes, `/api/analytics/track` and `/api/analytics/app-open`.
 *
 * An event is recorded only for an app the user holds (`hasAppGrant`, which
 * also refuses an app an admin switched off) and whose code may run now (the
 * app gate, src/lib/apps/app-gate.ts: not switched off, and not being
 * updated). The grant is asked first, as the MCP broker asks it. A page that
 * `pageVisibility` opens to any signed-in user is served without the grant,
 * but its opens and events are recorded only for users who hold the app.
 *
 * Every refusal gets one answer, `appNotFound()` below: the gateway's answer
 * for an app that isn't there (`notFound()` in src/lib/apps/dispatch.ts), and
 * on its public mount for a caller the app isn't open to. An app that doesn't
 * exist, one the user doesn't hold, one switched off and one being updated
 * look the same from outside, so these routes can't be used to find out which
 * apps an instance has or who holds them, whatever order the checks run in.
 * The gateway's 403 for a signed-in user without the grant would, beside a 404
 * for an unknown app, confirm that the app exists. Its 503 for an app being
 * updated isn't used either: the clients that send these events never retry,
 * so "try again shortly" would buy nothing, and a second answer is one more
 * thing a change to the order of the checks could turn into a tell.
 */

export interface AppEventLookups {
  apps: readonly AppManifest[];
  hasAppGrant: (userId: string, appSlug: string) => Promise<boolean>;
  checkAppGate: (appSlug: string) => Promise<AppGate>;
}

const PLATFORM: AppEventLookups = { apps: appRegistry, hasAppGrant, checkAppGate };

/**
 * The app `appSlug` names, when `userId` holds it and its code may run now;
 * otherwise null, and the event is refused with `appNotFound()`.
 *
 * The lookups are a parameter so the rule can be tested without a database.
 */
export async function openAppFor(
  userId: string,
  appSlug: string,
  lookups: AppEventLookups = PLATFORM,
): Promise<AppManifest | null> {
  const app = lookups.apps.find((a) => a.slug === appSlug);
  if (!app) return null;
  if (!(await lookups.hasAppGrant(userId, app.slug))) return null;
  if (!(await lookups.checkAppGate(app.slug)).open) return null;
  return app;
}

/** What a refused event gets: the gateway's 404 for an app that isn't there. */
export function appNotFound(): NextResponse {
  return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
}
