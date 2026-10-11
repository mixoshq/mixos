/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Following redirects by hand: the one redirect policy for both of this
 * feature's network paths, the catalogue client (`./client`) and the GitHub
 * download (`./fetch-source`).
 *
 * Left to itself, `fetch` follows up to twenty redirects, to any host, and from
 * https down to http as readily as the other way. A redirect is a second URL
 * chosen by whoever answered the first, and automatic following applies none of
 * the caller's rules to it: a download checked against GitHub's hosts, or a
 * catalogue request sent over https, could end up somewhere neither check would
 * have allowed.
 *
 * So both paths ask with `redirect: "manual"` and walk the chain here. Each
 * redirect is resolved against the URL that sent it and put through the
 * caller's check before it is requested, and at most `MAX_REDIRECTS` are
 * followed. The checks differ — a download must stay on GitHub and pinned to
 * its commit, a catalogue request on the catalogue's own origin — and the walk
 * does not.
 */

/**
 * The statuses `fetch` itself follows: the Fetch standard's redirect statuses.
 * Any other 3xx is an answer, as it is to `redirect: "follow"`.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * api.github.com → codeload.github.com is one hop, and a catalogue has no
 * reason to need more. Three is already generous.
 */
export const MAX_REDIRECTS = 3;

export interface RedirectRules {
  /**
   * The options for each request in the chain, called once per request.
   * `redirect` is always "manual". A signal created inside it times each
   * request on its own; one created outside it times the whole chain.
   */
  init: () => Omit<RequestInit, "redirect">;
  /**
   * Throw to refuse a redirect. `target` is its Location, already resolved
   * against the URL that sent it, and nothing has been sent to it yet.
   */
  check: (target: URL, status: number) => void;
  /** The error for a request that got no answer at all. */
  unreachable: (url: URL, err: unknown) => Error;
  /** The error for a redirect after `MAX_REDIRECTS` have been followed. */
  tooManyRedirects: (status: number) => Error;
}

/**
 * GET `start`, following a redirect only once `rules.check` has passed it.
 *
 * Returns the first response that is not a redirect, whatever its status, for
 * the caller to read as it reads any answer. A redirect with no usable Location
 * is returned too: with nowhere to go, it is an answer, as it is to `fetch`.
 */
export async function fetchCheckingRedirects(
  start: URL,
  rules: RedirectRules,
): Promise<Response> {
  let url = start;
  for (let followed = 0; ; followed++) {
    let res: Response;
    try {
      res = await fetch(url, { ...rules.init(), redirect: "manual" });
    } catch (err) {
      throw rules.unreachable(url, err);
    }

    const target = redirectTarget(res, url);
    if (!target) return res;

    // Its body is never read, so let the connection go before deciding.
    await res.body?.cancel().catch(() => {});
    rules.check(target, res.status);
    if (followed === MAX_REDIRECTS) throw rules.tooManyRedirects(res.status);
    url = target;
  }
}

/** Where `res` redirects to, resolved against `from`, or null if it is not a redirect to follow. */
function redirectTarget(res: Response, from: URL): URL | null {
  if (!REDIRECT_STATUSES.has(res.status)) return null;
  const location = res.headers.get("location");
  if (location === null) return null;
  try {
    // Resolving against the current URL handles a relative Location, which is
    // legal: the check then sees the absolute URL that would be requested.
    return new URL(location, from);
  } catch {
    return null;
  }
}
