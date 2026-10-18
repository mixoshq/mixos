/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import webpush from "web-push";
import { isPushServiceEndpoint } from "./endpoint";
import { getVapidConfig } from "./vapid";
import {
  deleteSubscriptionByEndpoint,
  getSubscriptionsForUsers,
} from "./subscriptions";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
}

/**
 * Send a push notification to every stored subscription of the given users.
 * Configures VAPID lazily (throws if unconfigured), and prunes subscriptions
 * the push service reports as gone (404/410) so dead endpoints don't pile up.
 * Returns how many pushes were accepted by the push service.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<{ sent: number }> {
  getVapidConfig(); // configures web-push; throws clearly if env is missing

  const subscriptions = await getSubscriptionsForUsers(userIds);
  if (subscriptions.length === 0) return { sent: 0 };

  const json = JSON.stringify(payload);
  let sent = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      // Checked again here, not only at subscribe time: this is the line that
      // makes the request, and the list of push services can change after a row
      // is stored. Skipped rather than deleted, so a push service added to the
      // list later finds it intact.
      if (!isPushServiceEndpoint(sub.endpoint)) {
        console.warn("[push] skipped a subscription that is not a push service endpoint");
        return;
      }
      try {
        await webpush.sendNotification(sub, json);
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        // 404/410: the endpoint is gone — drop it so we stop trying.
        if (status === 404 || status === 410) {
          await deleteSubscriptionByEndpoint(sub.endpoint).catch(() => {});
        } else {
          console.error(
            `[push] sendNotification failed (status ${status ?? "?"}):`,
            (err as Error)?.message ?? err,
          );
        }
      }
    }),
  );

  return { sent };
}
