/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run remove` — remove an app's, a connector's or a theme's code from this
// checkout. Its data stays in each database.
//
//   npm run remove                                  list the extensions in this checkout
//   npm run remove -- <app|connector|theme>/<slug>  remove it
//   npm run remove -- <slug>                        the same, when only one kind has that name
//   npm run remove -- --recover                     tidy up after a removal that stopped midway,
//                                                   or an install or registration that did
//   npm run remove -- --break-lock                  show who holds the checkout lock, and ask
//
// Removing shows what it would do and asks first. Then it moves the folder to
// .mixos/backup/, regenerates the registry without it, and deletes the backup,
// or puts the folder back if the registry generator fails without it. It holds
// the register lock in the database and the checkout lock (.mixos/lock) while
// it works, and records an audit row as `cli:<os user>@<hostname>`. It hands
// back the commit that deletes the folder; it never runs git to change
// anything.
//
// The work is in scripts/remove-cli.ts and src/lib/repository/remove.ts; what
// it shares with `npm run register` as a program is scripts/checkout-cli.ts.

import path from "path";
import { runCheckoutCli } from "./checkout-cli";

const ROOT = path.resolve(__dirname, "..");

// Before anything is imported: src/lib/repository/install.ts and
// src/lib/platform/build.ts read the checkout from the working directory.
process.chdir(ROOT);

runCheckoutCli(ROOT, () => import("./remove-cli"));
