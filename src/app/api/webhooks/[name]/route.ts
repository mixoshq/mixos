/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import { getClientIp } from "@/lib/apps/public-access";
import { getDecryptedConfig } from "@/lib/connectors/config";
import { isConnectorDisabled } from "@/lib/connectors/switch";
import { maintenanceState } from "@/lib/platform/maintenance";
import { maintenanceGate } from "@/lib/platform/maintenance-gate";
import {
  MAX_WEBHOOK_BODY_BYTES,
  claimWebhookDelivery,
  readCappedBody,
  releaseWebhookDelivery,
  verifyWebhookSignature,
} from "@/lib/connectors/webhook";
import { createRateLimiter } from "@/lib/rate-limit";
import type {
  BaseConnector,
  ConnectorWebhookEvent,
  WebhookCapableConnector,
} from "@/lib/connectors/types";

/**
 * Inbound connector webhooks.
 *
 * Public by necessity — the caller is a third-party server with no session — so
 * this lives under `/api/webhooks`, deliberately apart from the session-gated
 * `/api/connectors` routes that carry the OAuth flow. The URL space makes the
 * security posture legible: nothing under `/api/connectors` is ever public.
 *
 * Status codes here are chosen for how a *provider* reacts, not for REST
 * tidiness. Providers retry on non-2xx, so:
 *
 *  - a duplicate delivery answers 200 (the work is already done; a retry loop
 *    would achieve nothing),
 *  - a handler failure answers 500 *and releases the claim*, so the retry is
 *    actually processed rather than swallowed by the replay guard,
 *  - every verification failure, and a connector an admin has turned off,
 *    answers one uniform 401 with no detail, so the endpoint cannot be used to
 *    probe which secret or scheme is in use,
 *  - an address over its limit answers 429 with `Retry-After`, and a body over
 *    the cap answers 413, both before anything is decrypted or recorded, so a
 *    retry is processed as a first delivery,
 *  - while the platform schema is behind, everything answers the maintenance
 *    503 with `Retry-After`, first, as the proxy answers every other route.
 */
export const dynamic = "force-dynamic";

/**
 * Per IP, with the app gateway's budget (src/lib/apps/dispatch.ts): 60 in a
 * burst, then 10 a second. Generous, so a provider's bursts and retries pass.
 */
const webhookLimiter = createRateLimiter({
  scope: "ip",
  name: "connector-webhooks",
  maxTokens: 60,
  refillRatePerSecond: 10,
});

/** One response for every rejection: no oracle for an attacker to tune against. */
function rejected(): Response {
  return new Response(null, { status: 401 });
}

function tooManyRequests(retryAfterMs: number): Response {
  return new Response(null, {
    status: 429,
    headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
  });
}

/** The route reads no more of the body, so the connection isn't kept for another request. */
function tooLarge(): Response {
  return new Response(null, { status: 413, headers: { Connection: "close" } });
}

function supportsWebhooks(c: BaseConnector): c is WebhookCapableConnector {
  return typeof (c as WebhookCapableConnector).handleWebhook === "function";
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  // First, as src/proxy.ts does for every path it sees. The proxy leaves this
  // route out so that only this route reads a delivery's body, so it runs the
  // maintenance gate itself: while the platform schema is behind, a 503 with
  // `Retry-After`, and nothing else is read or recorded.
  const maintenance = await maintenanceGate(new URL(request.url).pathname, maintenanceState);
  if (maintenance) return maintenance;

  const { name } = await ctx.params;
  const manifest = connectorRegistry.find((c) => c.name === name);
  if (!manifest?.webhook) return new Response(null, { status: 404 });

  // Per IP, before the body is read and before anything below reads the
  // database or decrypts. The key is `getClientIp`'s, as for every limiter.
  const limit = await webhookLimiter.consume(getClientIp(request));
  if (!limit.allowed) return tooManyRequests(limit.retryAfterMs);

  // Raw bytes, before any parsing. Re-serialising JSON reorders keys and
  // rewrites whitespace, and the signature is over the bytes as sent. Read no
  // further than the cap.
  const rawBody = await readCappedBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (rawBody === null) return tooLarge();

  // Turned off by an admin (src/lib/connectors/switch.ts): the same 401 as a
  // connector with no signing secret saved, before anything is decrypted,
  // claimed or run. Nothing is marked as seen, so a delivery the provider
  // retries after the connector is back on is processed.
  if (await isConnectorDisabled(name)) {
    console.warn(`[connector-webhook] ${name} rejected: disabled`);
    return rejected();
  }

  const credentials = await getDecryptedConfig(name);
  const verified = verifyWebhookSignature({
    policy: manifest.webhook,
    secret: credentials?.[manifest.webhook.secretKey] ?? "",
    rawBody,
    headers: request.headers,
  });
  if (!verified.ok) {
    console.warn(`[connector-webhook] ${name} rejected: ${verified.reason}`);
    return rejected();
  }

  // Claim before doing any work, so two concurrent deliveries of the same event
  // cannot both run the handler.
  if (!(await claimWebhookDelivery(name, verified.eventKey))) {
    return Response.json({ ok: true, duplicate: true });
  }

  try {
    const mod = await import(`@connectors/${name}/index`);
    const ConnectorClass =
      mod.default ??
      mod[Object.keys(mod).find((k) => typeof mod[k] === "function")!];
    const instance: BaseConnector = new ConnectorClass();
    if (credentials) await instance.initialize(credentials);

    if (supportsWebhooks(instance)) {
      let body: unknown = rawBody;
      try {
        body = JSON.parse(rawBody);
      } catch {
        // Not JSON. Hand the handler the raw string rather than refusing —
        // form-encoded and plain-text webhooks both exist.
      }
      const event: ConnectorWebhookEvent = {
        body,
        rawBody,
        headers: Object.fromEntries(request.headers.entries()),
      };
      await instance.handleWebhook(event);
    }
    // A connector with a webhook policy but no handler still verifies and
    // acknowledges: the signature was valid, and 200 stops the retry loop.
    return Response.json({ ok: true });
  } catch (err) {
    // Undo the claim so the provider's retry is processed instead of being
    // silently deduped into oblivion.
    await releaseWebhookDelivery(verified.eventKey);
    console.error(`[connector-webhook] ${name} handler threw:`, err);
    return new Response(null, { status: 500 });
  }
}
