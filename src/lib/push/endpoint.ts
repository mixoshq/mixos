/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which URLs the server will send a Web Push message to.
 *
 * A subscription's endpoint arrives from the browser, through a route any
 * signed-in user can call, and the server later POSTs to it — so without a
 * check it is a URL of the user's choosing that the server requests. A real
 * endpoint is always issued by the browser's own push service, and there are
 * only a handful of those, so the check is a host allowlist rather than
 * resolve-and-recheck (src/lib/apps/http.ts):
 *
 *   - the destinations that are legitimate are a short list that rarely
 *     changes, and anything else is not a subscription at all;
 *   - it refuses public hosts too, not only private ones, so the server cannot
 *     be pointed at an arbitrary site;
 *   - it needs no DNS, so it reads the same when a subscription is saved and
 *     when a message is sent, and there is no answer to rebind.
 *
 * A browser whose push service is not listed cannot subscribe. That is the
 * trade: add its host here, rather than widening the rule.
 */

/** Exact hosts, and `*.` suffixes that admit any subdomain of a vendor zone. */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome and other Chromium browsers
  "updates.push.services.mozilla.com", // Firefox
  "*.push.apple.com", // Safari
  "*.notify.windows.com", // Edge
] as const;

function hostIsPushService(hostname: string): boolean {
  return PUSH_SERVICE_HOSTS.some((entry) => {
    if (!entry.startsWith("*.")) return hostname === entry;
    const suffix = entry.slice(1); // ".push.apple.com"
    return hostname.length > suffix.length && hostname.endsWith(suffix);
  });
}

/**
 * Is `endpoint` a URL on a known push service, written the way the URL parser
 * writes it?
 *
 * https only, no credentials, no explicit port. Requiring the canonical form
 * (`href` unchanged) matters because `web-push` re-parses the endpoint with
 * Node's legacy `url.parse()` to decide where to connect: a string the two
 * parsers could read differently never reaches it.
 */
export function isPushServiceEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string") return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.href === endpoint &&
    hostIsPushService(url.hostname)
  );
}
