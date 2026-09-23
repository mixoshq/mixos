/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { hasAppGrant } from "./access";
import { sendPushToUsers } from "@/lib/push/server";

export interface SendNotificationArgs {
  /** Recipient user ids. Filtered to users who have this app (see send()). */
  userIds: string[];
  title: string;
  body: string;
  /** In-app path opened on click, e.g. "/apps/my-app". */
  url?: string;
  /** Coalesces notifications that share a tag in the OS tray. */
  tag?: string;
  /** Icon URL; falls back to the MixOS app icon in the service worker. */
  icon?: string;
}

export interface NotificationsClient {
  send(args: SendNotificationArgs): Promise<{ sent: number }>;
}

/**
 * Per-app Web Push client, injected as `context.notifications` when an app
 * declares `"notifications": true`. Mirrors the `createScopedClient` (db)
 * pattern. `send()` only delivers to recipients who actually have this app
 * (global apps → everyone; otherwise an explicit grant), so one app can't
 * push to users of another.
 */
export function createNotificationsClient(
  appSlug: string,
): NotificationsClient {
  return {
    async send({ userIds, title, body, url, tag, icon }) {
      const unique = Array.from(new Set(userIds)).filter(Boolean);
      if (unique.length === 0) return { sent: 0 };

      const allowed = (
        await Promise.all(
          unique.map(async (id) => ((await hasAppGrant(id, appSlug)) ? id : null)),
        )
      ).filter((id): id is string => id !== null);

      if (allowed.length === 0) return { sent: 0 };

      return sendPushToUsers(allowed, { title, body, url, tag, icon });
    },
  };
}
