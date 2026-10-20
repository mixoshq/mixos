/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cache } from "react";
import { releaseCheckView } from "./release-check";

/**
 * The release check's view, read once per request: the banner over every page
 * (src/components/admin/release-banner.tsx) and the admin pages' notice
 * (src/components/settings/settings-shell.tsx) share one read of the stored
 * answer, and neither ever asks the network. A request-scoped memo, so it
 * never outlives the request that made it.
 */
export const releaseCheckViewThisRequest = cache(() => releaseCheckView());
