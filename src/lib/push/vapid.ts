/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setVapidDetails } from "web-push";
import { readSecret } from "@/lib/env/secrets";

/**
 * Web Push VAPID configuration, read from the environment. Locally these come
 * from `.env.local`; in production they are the host's environment variables
 * (docs/hosting/).
 *
 * Generate a keypair with: `npx web-push generate-vapid-keys`
 */
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let cached: VapidConfig | null = null;

/**
 * Returns the VAPID config and ensures the `web-push` library is configured
 * with it. Throws a clear error (mirroring `pgOptionsFromEnv`) if any var is
 * missing, so a misconfigured deployment fails loudly instead of silently
 * never delivering notifications.
 */
export function getVapidConfig(): VapidConfig {
  if (cached) return cached;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = readSecret("VAPID_PRIVATE_KEY");
  const subject = process.env.VAPID_SUBJECT;

  const missing = [
    ["VAPID_PUBLIC_KEY", publicKey],
    ["VAPID_PRIVATE_KEY", privateKey],
    ["VAPID_SUBJECT", subject],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(
      `Missing required Web Push env vars: ${missing.join(", ")}. ` +
        `Generate a keypair with \`npx web-push generate-vapid-keys\` and set ` +
        `them in .env.local (locally) or in your host's environment ` +
        `variables. VAPID_SUBJECT is a mailto: or https: URL.`,
    );
  }

  setVapidDetails(subject!, publicKey!, privateKey!);
  cached = { publicKey: publicKey!, privateKey: privateKey!, subject: subject! };
  return cached;
}

/** Whether Web Push is configured. Lets callers degrade gracefully. */
export function isPushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
      readSecret("VAPID_PRIVATE_KEY") &&
      process.env.VAPID_SUBJECT,
  );
}
