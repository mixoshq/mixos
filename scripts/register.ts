/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run register` — the second half of installing an app or a connector
// from the Registry, in this checkout.
//
//   npm run register                              list what is waiting in .mixos/pending/
//   npm run register -- <kind>/<slug>             register it
//   npm run register -- <slug>                    the same, when only one kind has it pending
//   npm run register -- app/<slug> --smoke        register it, then migrate, activate, grant and
//                                                 smoke-test it in this checkout's local database
//   npm run register -- <kind>/<slug> --discard   delete it from pending
//   npm run register -- --recover                 tidy up after one that stopped midway,
//                                                 or after a removal that did
//   npm run register -- --break-lock              show who holds the checkout lock, and ask
//
// Registering moves the extension into apps/ or connectors/ and runs the
// registry generator, which loads its code for the first time. It holds the
// register lock in the database and the checkout lock (.mixos/lock) while it
// works, and records an audit row as `cli:<os user>@<hostname>`.
//
// It finds the database the way the other scripts do (scripts/load-env.ts), and
// runs the generator with PATH and TMPDIR only. With `npm run dev:docker`, run
// it from your terminal: it reaches the stack's database as the dev server does.
//
// The work is in scripts/register-cli.ts and src/lib/repository/register.ts,
// and for --smoke, scripts/register-smoke.ts. What it shares with
// `npm run remove` as a program is scripts/checkout-cli.ts.

import path from "path";
import { runCheckoutCli } from "./checkout-cli";

const ROOT = path.resolve(__dirname, "..");

// Before anything is imported: src/lib/repository/install.ts and
// src/lib/platform/build.ts read the checkout from the working directory.
process.chdir(ROOT);

runCheckoutCli(ROOT, () => import("./register-cli"));
