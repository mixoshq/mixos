/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isPushServiceEndpoint } from "./endpoint";

test("endpoints the browsers' push services issue are accepted", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338qju59zJMjw2DELjzEvxwYv7hH5Ynpc1ODQ0aT4U4OFEeBHWKJlhGGvA1jfhJOrfxBexcMq",
    "https://fcm.googleapis.com/wp/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAH",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl-example_token",
    "https://web.push.apple.com/QGrbeEo9KAWzAYdfiVXkhD8PwMvkEwfBcjwcdOv0mUvkhs",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAABVdoq%2bExampleToken%3d",
  ]) {
    assert.equal(isPushServiceEndpoint(endpoint), true, endpoint);
  }
});

test("anything else the server would be made to POST to is refused", () => {
  for (const endpoint of [
    // Not a push service at all.
    "https://169.254.169.254/latest/meta-data/",
    "https://internal.corp.example/admin",
    "https://localhost/x",
    "https://10.0.0.5/x",
    // A push service's name used as a prefix, a label or a userinfo.
    "https://fcm.googleapis.com.attacker.example/fcm/send/x",
    "https://evil-fcm.googleapis.com.example/x",
    "https://fcm.googleapis.com@internal.example/fcm/send/x",
    "https://user:pass@fcm.googleapis.com/fcm/send/x",
    // The bare vendor zone, which the `*.` rule does not cover.
    "https://push.apple.com/x",
    // Wrong scheme, or an explicit port.
    "http://fcm.googleapis.com/fcm/send/x",
    "https://fcm.googleapis.com:8443/fcm/send/x",
    // Strings the URL parser would rewrite, which web-push's legacy parser
    // might read differently.
    "https://fcm.googleapis.com\\@internal.example/x",
    "https://FCM.googleapis.com/fcm/send/x",
    " https://fcm.googleapis.com/fcm/send/x",
    "https://fcm.googleapis.com",
    // Not a URL, or not a string.
    "fcm.googleapis.com/fcm/send/x",
    "",
    undefined,
    { href: "https://fcm.googleapis.com/fcm/send/x" },
  ]) {
    assert.equal(isPushServiceEndpoint(endpoint), false, String(endpoint));
  }
});
