/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../next.config";

// The setting can't be tested by its effect here, because that needs a running
// `next dev`. This test keeps it from being removed by accident. The reason is
// beside the setting in next.config.ts, and the reproduction is in
// docs/plans/20261116_0733-page-registry.md.
test("next dev runs without server Fast Refresh", () => {
  assert.equal(
    nextConfig.experimental?.turbopackServerFastRefresh,
    false,
    "With server Fast Refresh on, a route first built after `npm run registry` reads the registry from before it"
  );
});
