import { z } from "zod";
import { HttpConnector } from "@/lib/connectors/http-connector";
import type {
  ConnectorTestResult,
  ConnectorWebhookEvent,
} from "@/lib/connectors/types";

/**
 * Template connector — three-legged OAuth, plus an inbound webhook.
 *
 * Start from `connectors/_template/` unless your provider requires a user to
 * click "Allow". If a static API key works, use that one: this flow has more
 * moving parts and more ways for an admin to get stuck.
 *
 * How the authorization works, and what you do NOT write:
 *
 *   1. An admin saves the client ID and secret in the Connector Registry.
 *   2. They press **Connect**. The platform runs the consent round trip with
 *      PKCE and a signed, encrypted state cookie, and stores the resulting
 *      tokens in the same encrypted row as the client credentials.
 *   3. Before any call whose access token has expired, the platform refreshes
 *      it under a Postgres advisory lock and writes the new one back. That lock
 *      matters: providers commonly rotate the refresh token on use, so two
 *      concurrent refreshes can invalidate the grant permanently.
 *
 * None of that is your code. You write `testConnection()` and your methods, and
 * call `this.request()` — the `Authorization: Bearer` header is already there.
 *
 * **Tenant-scoped, not per-user.** One admin consents on behalf of everyone;
 * every user of every app shares that single grant. This is not per-user OAuth
 * and must not be used to act as individual users.
 *
 * Register this redirect URI with the provider — the Registry page shows the
 * exact value for your deployment:
 *
 *     https://<your-deployment>/api/connectors/<connector-name>/oauth/callback
 */

// `looseObject`, so a field the schema doesn't name still reaches the app.
const Thing = z.looseObject({ id: z.string(), title: z.string() });
type Thing = z.infer<typeof Thing>;

export default class TemplateOAuthConnector extends HttpConnector {
  readonly name = "_template-oauth";

  /**
   * Runs when an admin presses "Test Connection". With this flow it proves
   * three things at once: the client credentials are right, the grant exists,
   * and the token still refreshes.
   */
  async testConnection(): Promise<ConnectorTestResult> {
    const me = await this.request<{ account_name?: string }>("/v1/me");
    return {
      ok: true,
      detail: me?.account_name ? `Connected to ${me.account_name}` : undefined,
    };
  }

  async listThings(): Promise<Thing[]> {
    const page = await this.request("/v1/things", undefined, {
      schema: z.object({ data: z.array(Thing) }),
    });
    return page?.data ?? [];
  }

  /**
   * A write, declared `"mutates": true`. It needs `things:write`, which the
   * manifest requests with `"write"`: asked for at Connect only once an admin
   * has allowed this connector to change data. Until then the platform refuses
   * this before it runs, and the grant doesn't hold the scope anyway.
   */
  async createThing(data: { title: string }): Promise<Thing | null> {
    return this.request(
      "/v1/things",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      },
      { schema: Thing },
    );
  }

  /**
   * Optional. Implement this only alongside a `webhook` block in the manifest.
   *
   * By the time this runs the platform has already verified the HMAC over the
   * raw bytes, rejected anything outside the timestamp window, and claimed the
   * delivery so a duplicate cannot run it twice. So: do not re-check the
   * signature, and do not assume ordering.
   *
   * Throwing releases the claim and answers 500, which is how you ask the
   * provider to retry. Returning normally acknowledges the event — if you
   * swallow an error here, the delivery is gone for good.
   */
  async handleWebhook(event: ConnectorWebhookEvent): Promise<void> {
    const parsed = z
      .object({ type: z.string(), data: z.unknown() })
      .safeParse(event.body);
    if (!parsed.success) return; // Not a shape we act on; acknowledge and move on.

    switch (parsed.data.type) {
      case "thing.created":
      case "thing.updated":
        // Do the work — write to an app's tables, send a notification, etc.
        // Keep it short: the provider is waiting on this response.
        break;
      default:
        break;
    }
  }
}
