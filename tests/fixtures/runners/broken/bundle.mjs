/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A bundle that throws as it loads, for src/lib/runners/supervisor.test.ts. */
throw new Error("this bundle can't load");
