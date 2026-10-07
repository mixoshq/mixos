/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The platform's cryptographic key inventory — one env var per purpose.
 *
 * WHY THIS EXISTS. Five of these six keys used to be `CONNECTOR_ENCRYPTION_KEY`
 * itself, or derived from it via HMAC under distinct labels. The PRF separation
 * was sound — leaking a derivative could not recover the base key — but it made
 * the base key un-rotatable in practice: changing it simultaneously made every
 * stored connector credential undecryptable, invalidated every MCP token, every
 * app API key and every unlock cookie. A key that cannot be rotated is a key
 * whose compromise is unrecoverable, so the convenience of "no new environment
 * secret" was buying the wrong thing.
 *
 * Each key is now independent. Rotating one has a bounded, predictable blast
 * radius, listed per key below and in `docs/security-architecture.md` §5.
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
