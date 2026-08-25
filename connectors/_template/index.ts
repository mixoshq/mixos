import { z } from "zod";
import { HttpConnector } from "@/lib/connectors/http-connector";
import type { ConnectorTestResult } from "@/lib/connectors/types";

/**
 * Template connector — an API-key service.
 *
 * The registry skips folders starting with `_`, so this ships as a reference.
 * To use it:
 *
 *   1. Copy `connectors/_template/` to `connectors/<your-service>/`
 *      (lowercase, hyphens — no leading underscore).
 *   2. In `connector.json`: set `name` to match the folder exactly, then fill in
 *      `displayName`, `description`, `authors`, `credentialFields`, and the
 *      `auth` / `http` policy for your API.
 *   3. Rename the class and its `name` field below to match.
 *   4. Replace the example methods with the calls your apps need.
 *   5. `npm run registry && npm run typecheck && npm run verify:connectors`
 *
 * What you do NOT write, because `HttpConnector` already does it:
 * authentication, timeouts, retries with backoff, `Retry-After` handling,
 * turning HTTP statuses into typed errors, and the plain-English message a user
 * eventually reads. Call `this.request()` and let a failure throw.
 *
 * Three rules that matter more than the code:
 *
 *   - **Never read `process.env` and never hardcode a secret.** Credentials
 *     arrive only through `initialize()`, from the admin-configured, encrypted
 *     `connector_configs` row.
 *   - **Stay stateless.** The platform builds a fresh instance per request.
 *     Nothing may be cached on the class, at module scope, or between requests.
 *   - **Never surface an upstream error body.** Those routinely carry account
 *     and tenant detail. `this.request()` already drops them; don't add them
 *     back by catching and re-throwing with the response text.
 */

// Declaring the shape you expect turns "the upstream quietly changed" from an
// undefined-property crash inside a widget into a clear connector error naming
// the field that moved. Optional, but cheap and worth it on anything an app
// renders directly.
const Item = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string().optional(),
});
type Item = z.infer<typeof Item>;

export default class TemplateConnector extends HttpConnector {
  readonly name = "_template";

  /**
   * Required. One cheap call that proves the credentials actually work — this
   * is what the Registry's "Test Connection" button runs, and it is how a
   * non-technical admin finds out they pasted the key wrong now rather than
   * through a broken widget next week.
   *
   * Let failures throw: `request()` already produces the right typed error.
   */
  async testConnection(): Promise<ConnectorTestResult> {
    const me = await this.request<{ name?: string }>("/me");
    return { ok: true, detail: me?.name ? `Authenticated as ${me.name}` : undefined };
  }

  // ── Public methods for apps to call ──
  // One method per API operation. Let the app layer compose them.

  /** A single item, validated against the declared shape. */
  async getItem(id: string): Promise<Item | null> {
    return this.request(`/items/${encodeURIComponent(id)}`, undefined, { schema: Item });
  }

  /**
   * Every item, following the pagination style declared in `connector.json`.
   * Bounded by `maxPages`, so a cursor that never terminates cannot spin.
   */
  async listItems(): Promise<Item[]> {
    const items: Item[] = [];
    for await (const item of this.paginate<Item>("/items", { itemSchema: Item })) {
      items.push(item);
    }
    return items;
  }

  /**
   * A write. Note what is NOT here: no retry configuration. A POST is never
   * auto-retried, because a silently duplicated write is worse than a visible
   * failure. If your API is genuinely idempotent (it takes an idempotency key,
   * or the operation is a no-op when repeated), opt in with
   * `{ idempotent: true }` — deliberately, per call.
   */
  async createItem(data: Record<string, unknown>): Promise<Item | null> {
    return this.request("/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }, { schema: Item });
  }
}
