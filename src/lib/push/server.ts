import webpush from "web-push";
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
