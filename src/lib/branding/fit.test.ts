/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fitLogo, LOGIN_LOGO_BOX, MENU_BAR_LOGO_BOX } from "./fit";

const src = "/themes/x/logo.png";

test("the default mark lands at the sizes it was always drawn at", () => {
  // themes/mixos/assets/logo.png is 256x244. Before marks were measured, the
  // bar drew it at 24x23 and the sign-in page at 72x69.
  const logo = { src, width: 256, height: 244 };
  assert.deepEqual(fitLogo(logo, MENU_BAR_LOGO_BOX), { src, width: 24, height: 23 });
  assert.deepEqual(fitLogo(logo, LOGIN_LOGO_BOX), { src, width: 72, height: 69 });
});

test("a wide mark keeps its ratio at the box height", () => {
  assert.deepEqual(fitLogo({ src, width: 600, height: 150 }, MENU_BAR_LOGO_BOX), {
    src,
    width: 92,
    height: 23,
  });
});

test("a mark wider than the cap is scaled down whole, not squashed", () => {
  const logo = { src, width: 1000, height: 100 };
  assert.deepEqual(fitLogo(logo, MENU_BAR_LOGO_BOX), { src, width: 160, height: 16 });
  assert.deepEqual(fitLogo(logo, LOGIN_LOGO_BOX), { src, width: 240, height: 24 });
});

test("a tall mark keeps the box height", () => {
  assert.deepEqual(fitLogo({ src, width: 100, height: 400 }, LOGIN_LOGO_BOX), {
    src,
    width: 17,
    height: 69,
  });
});
