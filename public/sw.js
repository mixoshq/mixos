/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// MixOS service worker — Web Push delivery.
//
// Served at /sw.js (root scope) so push events reach every app surface.
// Registered globally by src/components/push/register-sw.tsx. The payload is
// produced by src/lib/push/server.ts (PushPayload: title, body, url?, tag?, icon?).
//
// Deliberately NOT a caching proxy. The offline screen is text-only, so there is
// nothing to cache and no install/activate/fetch handling to reason about on
// every deploy.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "MixOS", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "MixOS";
  const options = {
    body: data.body || "",
    // `icon` is the large image shown in the notification; apps may override it
    // per-send via payload.icon. `badge` is the small monochrome glyph some
    // platforms (e.g. Android) show in the status bar.
    icon: data.icon || "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag,
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing MixOS tab if one is open; otherwise open a new one.
        for (const client of clientList) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
