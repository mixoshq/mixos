/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * App Manager's address, filtered. Its own module rather than beside the list
 * that reads it: that list is a client component, and a value exported from
 * one reaches a server component as a client reference, not the string.
 */

/** The query parameter that opens App Manager with the Widgets filter on. */
export const WIDGETS_PARAM = "widgets";

/** App Manager, showing only apps with widgets: for a dashboard with nothing to add. */
export const APPS_WITH_WIDGETS_URL = `/apps?${WIDGETS_PARAM}=1`;
