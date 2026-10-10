/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Thrown when an app's manifest contains an invalid visibility declaration.
 * Distinct from generic load errors because we want misconfigured visibility
 * to *abort the entire generator run* instead of being silently swallowed
 * by the per-app `Skipping ...` warning path. A public/password mis-declaration
 * is a security-relevant config issue and must not ship.
 *
 * Its own module so the checks the generator delegates to other files — and
 * their tests — throw the class the generator's `instanceof` recognises. A
 * look-alike class would be caught as an ordinary error and turn an abort into
 * a skipped app.
 */
export class FatalManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalManifestError";
  }
}
