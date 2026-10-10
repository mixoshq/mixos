/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { connectorRegistry } from "@/generated/connector-registry";
import { getDecryptedConfig } from "@/lib/connectors/config";
import { isConnectorDisabled } from "@/lib/connectors/switch";
import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
  verifyWebhookSignature,
} from "@/lib/connectors/webhook";
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
 *    probe which secret or scheme is in use.
 */
export const dynamic = "force-dynamic";

/** One response for every rejection: no oracle for an attacker to tune against. */
function rejected(): Response {
  return new Response(null, { status: 401 });
}

function supportsWebhooks(c: BaseConnector): c is WebhookCapableConnector {
  return typeof (c as WebhookCapableConnector).handleWebhook === "function";
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  const manifest = connectorRegistry.find((c) => c.name === name);
  if (!manifest?.webhook) return new Response(null, { status: 404 });

  // Turned off by an admin (src/lib/connectors/switch.ts): the same 401 as a
  // connector with no signing secret saved, before anything is decrypted,
  // claimed or run. Nothing is marked as seen, so a delivery the provider
  // retries after the connector is back on is processed.
  if (await isConnectorDisabled(name)) {
    console.warn(`[connector-webhook] ${name} rejected: disabled`);
    return rejected();
  }

  // Raw bytes, before any parsing. Re-serialising JSON reorders keys and
  // rewrites whitespace, and the signature is over the bytes as sent.
  const rawBody = await request.text();

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
