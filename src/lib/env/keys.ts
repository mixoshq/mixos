/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The platform's cryptographic key inventory — one env var per purpose.
 *
 * WHY THIS EXISTS. Each key is independent, so rotating one has a bounded,
 * predictable blast radius, listed per key below and in
 * `docs/security-architecture.md` §5. Deriving them from one base key via HMAC
 * under distinct labels would be sound — leaking a derivative could not recover
 * the base — but it would make the base un-rotatable in practice: changing it
 * would at once make every stored connector credential undecryptable and
 * invalidate every MCP token, every app API key and every unlock cookie. A key
 * that cannot be rotated is a key whose compromise is unrecoverable.
 *
 * NO DERIVATION FALLBACK, deliberately. A fallback to `CONNECTOR_ENCRYPTION_KEY`
 * would mean nobody ever sets the others and the single point of failure quietly
 * survives. A missing key fails closed with a message naming the variable and
 * the command that generates it.
 *
 * FORMAT. All six are 32 random bytes. Uniform on purpose: one generator
 * command, one validation path, one thing to remember. Two spellings of those
 * bytes are accepted:
 *
 *   - hex, 64 characters — what `npm run keys:generate` prints;
 *   - base64, 44 characters (or 43 unpadded, or base64url) — what hosting
 *     platforms' secret generators produce. Render's `generateValue` and
 *     Coolify's SERVICE_REALBASE64_32_* are exactly 32 random bytes in base64,
 *     so a one-click deploy can generate every key without a person pasting
 *     anything.
 *
 * The two cannot be confused: a 64-character string is only ever read as hex.
 */

const KEY_BYTES = 32;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=?$|^[A-Za-z0-9_-]{43}=?$/;

/** The key's 32 bytes, or null when `raw` is neither spelling of 32 bytes. */
function decodeKey(raw: string): Buffer | null {
  if (HEX_KEY.test(raw)) return Buffer.from(raw, "hex");
  if (BASE64_KEY.test(raw)) {
    const bytes = Buffer.from(raw, /[-_]/.test(raw) ? "base64url" : "base64");
    return bytes.length === KEY_BYTES ? bytes : null;
  }
  return null;
}

export interface PlatformKeySpec {
  /** Environment variable holding the key. */
  env: string;
  /** What it protects. */
  purpose: string;
  /** What breaks when it is rotated — the blast radius, stated up front. */
  rotationEffect: string;
}

/**
 * The inventory. `scripts/generate-keys.ts` enumerates this, so a key added here
 * is generated and checked without anyone remembering to update that script.
 */
export const PLATFORM_KEYS = {
  connectorEncryption: {
    env: "CONNECTOR_ENCRYPTION_KEY",
    purpose:
      "AES-256-GCM encryption of tenant connector credentials in connector_configs.",
    rotationEffect:
      "Every stored tenant connector credential becomes undecryptable; an admin must re-enter each one.",
  },
  userOauthEncryption: {
    env: "USER_OAUTH_ENCRYPTION_KEY",
    purpose:
      "AES-256-GCM encryption of per-user OAuth grants in user_connector_oauth (userScoped connectors).",
    rotationEffect:
      "Every user's connector grant becomes undecryptable; each person must reconnect their own account.",
  },
  mcpToken: {
    env: "MCP_TOKEN_KEY",
    purpose:
      "HMAC-SHA256 digest key for MCP access tokens, refresh tokens and authorization codes.",
    rotationEffect:
      "Every issued MCP token and code stops resolving; clients must re-authorize.",
  },
  appApiKey: {
    env: "APP_API_KEY_SECRET",
    purpose: "HMAC-SHA256 digest key for app API keys (the `key` auth tier).",
    rotationEffect:
      "Every app API key stops resolving; each integration must be re-minted.",
  },
  appSettingsEncryption: {
    env: "APP_SETTINGS_ENCRYPTION_KEY",
    purpose:
      "AES-256-GCM encryption of `password`-typed app settings in app_settings (context.env).",
    rotationEffect:
      "Every encrypted app setting becomes undecryptable; an admin must re-enter each one.",
  },
  appUnlock: {
    env: "APP_UNLOCK_SECRET",
    purpose: "HMAC-SHA256 signing key for app password-unlock cookies.",
    rotationEffect:
      "Every unlocked visitor is logged out of password-protected apps and re-enters the password.",
  },
} as const satisfies Record<string, PlatformKeySpec>;

export type PlatformKeyName = keyof typeof PLATFORM_KEYS;

/**
 * Keys a deployment may leave unset, each turning on one feature. Unset means
 * the feature is off; set, they follow the same rules as PLATFORM_KEYS: 32
 * random bytes, independent of every other key, and a malformed value is an
 * error naming the variable, never a quiet "off".
 *
 * Not in PLATFORM_KEYS on purpose: `npm run keys:generate` prints those for
 * every deployment, and a key here is opted into, so it is printed only when
 * asked for (`npm run keys:generate -- --github-app`).
 */
export const OPTIONAL_PLATFORM_KEYS = {
  githubAppEncryption: {
    env: "GITHUB_APP_ENCRYPTION_KEY",
    purpose:
      "AES-256-GCM encryption of the GitHub App's private key in platform_settings. Unset, the GitHub App is off.",
    rotationEffect:
      "The stored App key can't be read until `npm run keys:rotate-github-app` re-encrypts it, given the old and the new key. Nothing else changes.",
  },
} as const satisfies Record<string, PlatformKeySpec>;

export type OptionalPlatformKeyName = keyof typeof OPTIONAL_PLATFORM_KEYS;

/** The 32 bytes `raw` spells, or null when it is neither spelling of 32 bytes. */
export function parseKeyValue(raw: string): Buffer | null {
  return decodeKey(raw);
}

/**
 * Read one optional key: null when it is unset or empty, which turns its
 * feature off. Throws, naming the variable, when it is set to anything that
 * isn't 32 bytes: a mistyped key must not read as "off" any more than a
 * required one may read as "on".
 */
export function optionalPlatformKey(name: OptionalPlatformKeyName): Buffer | null {
  const spec = OPTIONAL_PLATFORM_KEYS[name];
  const raw = process.env[spec.env];
  if (!raw) return null;
  const key = decodeKey(raw);
  if (!key) {
    throw new Error(
      `${spec.env} must be ${KEY_BYTES} random bytes, as ${KEY_BYTES * 2} hex characters or ` +
        `as base64; got ${raw.length} character(s). Unset it to turn the feature off, or ` +
        `generate one with: npm run keys:generate -- --github-app`,
    );
  }
  return key;
}

/** The optional keys that are set but malformed, in the shape `missingPlatformKeys()` uses. */
export function malformedOptionalKeys(): { env: string; reason: string }[] {
  const malformed: { env: string; reason: string }[] = [];
  for (const name of Object.keys(OPTIONAL_PLATFORM_KEYS) as OptionalPlatformKeyName[]) {
    try {
      optionalPlatformKey(name);
    } catch (err) {
      malformed.push({
        env: OPTIONAL_PLATFORM_KEYS[name].env,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return malformed;
}

/**
 * The two other secrets every deployment needs. Not platform keys, because
 * nothing here decodes them: Auth.js reads AUTH_SECRET itself, and /api/cron
 * compares CRON_SECRET as an opaque string, so any value works and only an
 * unset one is an error. `scripts/generate-keys.ts` generates and checks them
 * alongside the platform keys, so one command covers a whole deployment.
 */
export const DEPLOYMENT_SECRETS = {
  authSecret: {
    env: "AUTH_SECRET",
    purpose: "Signs sessions and CSRF tokens (Auth.js).",
    rotationEffect: "Everyone is signed out and signs in again.",
  },
  cronSecret: {
    env: "CRON_SECRET",
    purpose: "The bearer token the scheduler tick sends to /api/cron.",
    rotationEffect:
      "Ticks are refused until whatever sends them (Vercel Cron, the cron service) has the new value.",
  },
} as const satisfies Record<string, PlatformKeySpec>;

export type DeploymentSecretName = keyof typeof DEPLOYMENT_SECRETS;

/** Which of DEPLOYMENT_SECRETS are unset, in the shape `missingPlatformKeys()` uses. */
export function missingDeploymentSecrets(): { env: string; reason: string }[] {
  return Object.values(DEPLOYMENT_SECRETS)
    .filter((spec) => !process.env[spec.env])
    .map((spec) => ({ env: spec.env, reason: `${spec.env} is not set. ${spec.purpose}` }));
}

/**
 * Read and validate one platform key.
 *
 * Throws with an actionable message rather than returning a weak or wrong-length
 * buffer — a silently truncated key is a control that appears to work.
 */
export function platformKey(name: PlatformKeyName): Buffer {
  const spec = PLATFORM_KEYS[name];
  const raw = process.env[spec.env];

  if (!raw) {
    throw new Error(
      `${spec.env} is not set. ${spec.purpose}\n` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('hex'))"`,
    );
  }

  const key = decodeKey(raw);
  if (!key) {
    throw new Error(
      `${spec.env} must be ${KEY_BYTES} random bytes, as ${KEY_BYTES * 2} hex characters or ` +
        `as base64; got ${raw.length} character(s). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('hex'))"`,
    );
  }

  return key;
}

/**
 * Which platform keys are missing or malformed. Used by the environment check so
 * an operator learns about all of them at once rather than one restart at a time.
 */
export function missingPlatformKeys(): { env: string; reason: string }[] {
  const missing: { env: string; reason: string }[] = [];
  for (const name of Object.keys(PLATFORM_KEYS) as PlatformKeyName[]) {
    try {
      platformKey(name);
    } catch (err) {
      missing.push({
        env: PLATFORM_KEYS[name].env,
        reason: err instanceof Error ? err.message.split("\n")[0] : String(err),
      });
    }
  }
  return missing;
}
