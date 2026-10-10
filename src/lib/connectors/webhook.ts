/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "@/lib/db/client";
import type { ConnectorWebhookPolicy } from "./types";

/**
 * Inbound webhook verification.
 *
 * Three independent checks, in order, because each one alone is insufficient:
 *
 *  1. **Signature** — proves the payload came from the provider.
 *  2. **Timestamp** — a signature is valid forever, so without a freshness
 *     window an attacker who captured one delivery can replay it indefinitely.
 *  3. **Replay** — even inside the window, the same delivery must apply once.
 *     Without a timestamp there is no window, and this is the only check that
 *     refuses a replay, so its record is kept for 90 days rather than one
 *     (`pruneWebhookEvents`).
 *
 * The signed payload is `${timestamp}.${rawBody}` when the policy declares a
 * timestamp header, and the raw body alone otherwise. That covers the common
 * schemes; a provider doing something unusual needs its own verification rather
 * than a manifest flag that lies about what was checked.
 *
 * Everything here operates on the RAW body. Re-serialising parsed JSON changes
 * key order and whitespace, and the signature is over bytes.
 */

export type WebhookRejection =
  | "not-configured"
  | "missing-signature"
  | "bad-signature"
  | "stale"
  | "replay";

export type WebhookVerification =
  | { ok: true; eventKey: string }
  | { ok: false; reason: WebhookRejection };

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * How long a delivery marker is kept, in days. With a signed timestamp the
 * freshness window (at most an hour either side) refuses a replay well inside
 * a day. Without one the marker is the only thing refusing it, so it is kept
 * far longer — though not forever, which is the trade the 90 days make: a
 * delivery captured longer ago than that could be accepted once more.
 */
const TIMED_RETENTION_DAYS = 1;
const UNTIMED_RETENTION_DAYS = 90;

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify signature and freshness. Does not touch the database — the replay
 * check is separate so a caller can decide when to claim the delivery.
 */
export function verifyWebhookSignature(opts: {
  policy: ConnectorWebhookPolicy;
  secret: string;
  rawBody: string;
  headers: Headers;
  now?: number;
}): WebhookVerification {
  const { policy, secret, rawBody, headers } = opts;
  const now = opts.now ?? Date.now();

  if (!secret) return { ok: false, reason: "not-configured" };

  const presented = headers.get(policy.signatureHeader);
  if (!presented) return { ok: false, reason: "missing-signature" };

  // Providers commonly prefix the digest with its algorithm ("sha256=abc…") —
  // but base64 digests END in "=" padding, so splitting on the first "=" would
  // mangle a perfectly good base64 signature. Rather than guess which shape
  // this is, keep both readings and accept whichever verifies.
  const presentedTrimmed = presented.trim();
  const candidates = [presentedTrimmed];
  const sep = presentedTrimmed.indexOf("=");
  if (sep > 0 && sep < presentedTrimmed.length - 1) {
    candidates.push(presentedTrimmed.slice(sep + 1));
  }

  let signedPayload = rawBody;
  if (policy.timestampHeader) {
    const raw = headers.get(policy.timestampHeader);
    if (!raw) return { ok: false, reason: "missing-signature" };

    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return { ok: false, reason: "stale" };
    // Accept seconds or milliseconds — providers disagree, and guessing wrong
    // turns every delivery into a freshness failure.
    const sentAt = numeric > 1e12 ? numeric : numeric * 1000;
    const toleranceMs = (policy.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
    if (Math.abs(now - sentAt) > toleranceMs) return { ok: false, reason: "stale" };

    signedPayload = `${raw}.${rawBody}`;
  }

  const algorithm = policy.algorithm === "hmac-sha1" ? "sha1" : "sha256";
  const mac = createHmac(algorithm, secret).update(signedPayload, "utf8").digest();

  // Providers encode the digest as hex or base64. Check both rather than adding
  // a manifest field nobody will get right on the first try.
  const expected = [mac.toString("hex"), mac.toString("base64")];
  const matches = candidates.some((candidate) =>
    expected.some((want) => constantTimeEquals(candidate, want)),
  );
  if (!matches) return { ok: false, reason: "bad-signature" };

  // The dedupe key is a digest of the MAC that verified, not of the header as
  // sent. One MAC has many accepted spellings — hex or base64, bare or behind
  // any `prefix=` — so a key taken from the header let a captured delivery
  // replay under a fresh key just by being re-spelled. The MAC is one value per
  // signed payload (timestamp and body), however it is written.
  return { ok: true, eventKey: createHash("sha256").update(mac).digest("hex") };
}

/**
 * Claim a delivery. Returns false when this signed payload has been seen
 * before — the insert itself is the check, so two concurrent deliveries of the
 * same event cannot both win.
 */
export async function claimWebhookDelivery(
  connectorName: string,
  eventKey: string,
): Promise<boolean> {
  const rows = await sql<{ event_key: string }[]>`
    insert into public.connector_webhook_events (event_key, connector_name)
    values (${eventKey}, ${connectorName})
    on conflict (event_key) do nothing
    returning event_key
  `;
  return rows.length > 0;
}

/**
 * Drop delivery markers that no longer carry weight. Called from the cron tick,
 * which passes `timestamped`: the connectors whose policy signs a timestamp,
 * read off the registry.
 *
 *   - A timestamped connector's markers go after a day. Past the freshness
 *     window the timestamp check already refuses a replay.
 *   - Every other marker goes after 90 days. Without a signed timestamp a
 *     signature stays valid for as long as the secret does, so the marker is
 *     the only thing refusing a replay. Ninety days bounds the table at a
 *     stated cost: for a connector that signs no timestamp, a delivery
 *     captured more than 90 days ago could be accepted once.
 *
 * Returns how many markers went.
 */
export async function pruneWebhookEvents(
  timestamped: readonly string[],
): Promise<number> {
  let pruned = 0;
  // Swallows its own errors, matching pruneRateBuckets: this runs after the
  // scheduler tick and a failed sweep must not report the tick as failed.
  try {
    const expired = await sql<{ event_key: string }[]>`
      delete from public.connector_webhook_events
       where received_at < now() - ${UNTIMED_RETENTION_DAYS} * interval '1 day'
      returning event_key
    `;
    pruned += expired.length;

    // `in ()` is not SQL, and with no timestamped policy there is nothing to do.
    if (timestamped.length === 0) return pruned;
    const stale = await sql<{ event_key: string }[]>`
      delete from public.connector_webhook_events
       where received_at < now() - ${TIMED_RETENTION_DAYS} * interval '1 day'
         and connector_name in ${sql([...timestamped])}
      returning event_key
    `;
    pruned += stale.length;
  } catch {
    // Best-effort: report what did go.
  }
  return pruned;
}

/**
 * Release a claim after the handler failed.
 *
 * Without this, a handler that throws leaves the delivery marked as seen: the
 * provider retries, the replay guard silently swallows it, and the event is
 * lost with every party believing it succeeded. Claiming is only safe because
 * it is reversible.
 */
export async function releaseWebhookDelivery(eventKey: string): Promise<void> {
  await sql`delete from public.connector_webhook_events where event_key = ${eventKey}`;
}
