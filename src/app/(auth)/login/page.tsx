/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getActiveTheme } from "@/lib/themes/active";
import LoginCard from "./login-card";

/**
 * The active theme is a row in `platform_settings`, so this page has to render
 * per request: prerendered at build time it would bake in whichever theme was
 * installed then, and an admin switching themes would never reach the one page
 * every user sees first.
 *
 * It carried `force-dynamic` before for `isSsoEnabled()`; that reason went away
 * with SSO, this one replaced it.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const { theme } = await getActiveTheme();

  // The mark comes from the active theme, not from public/ — this page is the
  // first thing a user sees, and it should carry whatever brand the install is
  // actually running. When a theme ships no logo the wordmark stands alone,
  // which is a legitimate treatment rather than a broken state.
  const logo = theme.assets.logo
    ? `${theme.assetBase}/${theme.assets.logo}`
    : null;

  return <LoginCard logo={logo} />;
}
