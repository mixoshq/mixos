/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServiceClient } from "@/lib/db/server";
import { isPushServiceEndpoint } from "./endpoint";

/** A stored Web Push subscription, shaped for `web-push`'s sendNotification. */
export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The browser PushSubscription JSON posted from the client. */
export interface RawSubscription {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
}

/**
 * Persist (or refresh) a subscription for a user. Keyed on the globally unique
 * endpoint, so re-subscribing from the same browser updates the row and
 * reassigns ownership rather than duplicating.
 *
 * The server later POSTs to the endpoint, so only a push service's is stored
 * (see ./endpoint.ts).
 */
export async function saveSubscription(
  userId: string,
  sub: RawSubscription,
  userAgent: string | null,
): Promise<void> {
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (!sub.endpoint || !p256dh || !auth) {
    throw new Error("Invalid push subscription: missing endpoint or keys");
  }
  if (!isPushServiceEndpoint(sub.endpoint)) {
    throw new Error("Invalid push subscription: not a push service endpoint");
  }

  const supabase = createServiceClient();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh,
      auth,
      user_agent: userAgent,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );
  if (error) throw new Error(`Failed to save subscription: ${error.message}`);
}

/**
 * Remove one of a user's own subscriptions — what the unsubscribe route calls.
 * Pinned to `userId` as well as the endpoint, so a user who learns someone
 * else's endpoint still cannot remove it.
 */
export async function deleteUserSubscription(
  userId: string,
  endpoint: string,
): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", userId)
    .eq("endpoint", endpoint);
}

/**
 * Remove a subscription whoever owns it. Only for the server's own pruning,
 * when the push service reports the endpoint gone (404/410) — never for a
 * request a user made.
 */
export async function deleteSubscriptionByEndpoint(
  endpoint: string,
): Promise<void> {
  const supabase = createServiceClient();
  await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** All subscriptions for the given users, in one query. */
export async function getSubscriptionsForUsers(
  userIds: string[],
): Promise<StoredSubscription[]> {
  if (userIds.length === 0) return [];
  const supabase = createServiceClient();

  const { data } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", userIds);

  const subs: StoredSubscription[] = [];
  for (const row of (data ?? []) as SubscriptionRow[]) {
    subs.push({
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    });
  }
  return subs;
}
