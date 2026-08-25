# Webhooks

Connectors can receive inbound events, not just poll. Declare a `webhook` block
in `connector.json` and implement `handleWebhook()`; the platform does the
verification.

## Declare it

```jsonc
"credentialFields": [
  { "key": "webhookSecret", "label": "Webhook Signing Secret", "type": "password" }
],
"webhook": {
  "algorithm": "hmac-sha256",             // or "hmac-sha1"
  "signatureHeader": "X-Provider-Signature",
  "timestampHeader": "X-Provider-Timestamp", // omit if the scheme has no timestamp
  "toleranceSeconds": 300,
  "secretKey": "webhookSecret"            // must exist in credentialFields
}
```

The endpoint is `POST /api/webhooks/<connector-name>`. Give the provider that
URL.

`secretKey` is cross-checked against `credentialFields` at build time — naming a
credential that nobody is ever asked for fails the build rather than failing
silently at 3am.

## Handle it

```ts
async handleWebhook(event: ConnectorWebhookEvent): Promise<void> {
  // event.body — parsed JSON (or the raw string if it wasn't JSON)
  // event.rawBody — the exact bytes that were signed
  // event.headers
}
```

By the time this runs the platform has verified the HMAC over the raw bytes,
rejected anything outside the timestamp window, and claimed the delivery so a
duplicate cannot run it twice. **Do not re-verify the signature**, and do not
assume ordering.

Throwing releases the claim and answers 500, which asks the provider to retry.
Returning normally acknowledges the event — swallow an error here and the
delivery is gone for good.

## What the platform checks, and why each one is needed

1. **Signature** — HMAC over `${timestamp}.${rawBody}` when a timestamp header
   is declared, or the raw body alone otherwise. Both hex and base64 digests are
   accepted, with or without an `alg=` prefix.
2. **Freshness** — a signature stays valid forever. Without a timestamp window,
   anyone who observes one delivery can replay it indefinitely and the signature
   still checks out.
3. **Replay** — even inside the window, the same delivery must apply once. The
   signature digest is recorded in `connector_webhook_events`; a repeat answers
   `200 {"duplicate": true}` without running the handler.

Every verification failure returns the same bare `401`, so the endpoint cannot
be used to probe which secret or scheme is in use.

## Why the route lives outside `/api/connectors`

Webhooks are unauthenticated by nature — the caller is a third-party server with
no session — so they live under `/api/webhooks`, which is on the proxy's public
list. `/api/connectors` stays session-gated because the OAuth start and callback
routes live there. The URL space makes the security posture legible.

Removing `/api/webhooks` from the public list does not harden anything: the
delivery would redirect to `/login`, the provider would record a successful
delivery, and the event would be lost silently. The signature check is the gate.
