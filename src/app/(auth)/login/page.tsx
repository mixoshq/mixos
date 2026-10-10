/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getBrandName, getLoginLogo } from "@/lib/branding/resolve";
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
  // The name and mark come from the install's brand — the active theme, and
  // the brand filters of active apps where the theme leaves room — never from
  // public/. This page is the first thing a user sees, and it should carry
  // whatever brand the install is actually running. With no mark the wordmark
  // stands alone, which is a legitimate treatment rather than a broken state.
  // Never the menu-bar mark: this page does not draw it, so it does not wait
  // on its filters either.
  const [name, loginLogo] = await Promise.all([getBrandName(), getLoginLogo()]);

  return <LoginCard logo={loginLogo} name={name} />;
}
