/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the documentation lives.
 *
 * Deliberately NOT derived from `repositoryBaseUrl()`. That override exists so
 * the platform and the catalogue can be developed against each other, and it
 * carries a release-build lock because the catalogue decides what "verified"
 * means for every install. Documentation decides nothing; a docs link that
 * followed the catalogue override would drag a security control into a place
 * it has no business being, to solve a problem nobody has (reading the docs
 * from a laptop-hosted copy of the site).
 */
export const MIXOS_DOCS_URL = "https://mixos.org/docs";

/** An absolute link into the docs, e.g. `docsUrl("extending/apps")`. */
export function docsUrl(path: string): string {
  return `${MIXOS_DOCS_URL}/${path.replace(/^\/+/, "")}`;
}
