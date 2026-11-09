/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Content-Security-Policy, with a fresh nonce per request.
 *
 * Built here and set by whichever of two places serves the path: the proxy
 * (src/proxy.ts) on every path its matcher covers, and the app API gateway
 * (src/lib/apps/dispatch.ts) on the two app API mounts, which that matcher
 * leaves out. Their paths don't overlap, so no response gets it twice.
 *
 * WHY NOT next.config.ts. A nonce has to be unique per request, so it cannot
 * come from static header config. Next reads the nonce out of the request's
 * `Content-Security-Policy` header during SSR and applies it to its own
 * framework scripts and bundles, which is what makes `strict-dynamic` workable
 * without hand-annotating every tag.
 *
 * Never set it in next.config.ts as well. Two `Content-Security-Policy` headers
 * are INTERSECTED by the browser, not merged, so leaving the old static
 * `frame-ancestors` header in next.config.ts alongside this one would silently
 * produce a policy stricter than either.
 *
 * `frame-ancestors 'self'` is carried over deliberately — MixOS frames its own
 * pages, and this is the only clickjacking control (X-Frame-Options is not set,
 * and frame-ancestors supersedes it).
 *
 * `script-src` is the point of the exercise. `'strict-dynamic'` means a script
 * that carries the nonce may load further scripts, and nothing else may — so an
 * injected `<script>` an attacker plants in the DOM does not run, because it
 * cannot guess the nonce.
 *
 * `style-src` keeps `'unsafe-inline'`, and that is a considered trade rather than
 * an oversight: React writes `style={{...}}` attributes throughout the dashboard
 * (the drag-and-drop grid computes positions inline), a style attribute cannot
 * execute script, and the XSS protection here comes from `script-src`. Tightening
 * this means moving to `style-src-attr` plumbing for no meaningful gain.
 *
 * `connect-src 'self'` reinforces the egress boundary from the browser side: app
 * client code reaches its own routes through the SDK and has no business opening
 * a socket to anywhere else. Raw `fetch` is already lint-banned in `apps/**`.
 *
 * `form-action 'self'` everywhere but the one page `formActionsFor()` names,
 * which posts GitHub's App manifest to github.com.
 *
 * DEV. React uses `eval` in development to reconstruct server error stacks, so
 * `'unsafe-eval'` is required there and only there.
 *
 * COST, stated plainly: a nonce forces every page to be dynamically rendered,
 * because the nonce only exists once a request does. Static optimization, ISR and
 * PPR are off. For a signed-in dashboard that already reads a session cookie on
 * every page this changes almost nothing; the one surface that could have been
 * cached is the public `/p/<slug>` view.
 */
export function buildCsp(nonce: string, options: { formActions?: readonly string[] } = {}): string {
  const isDev = process.env.NODE_ENV === "development";
  const formActions = ["'self'", ...(options.formActions ?? [])].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${formActions}`,
    "frame-ancestors 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/**
 * The one page whose form may post somewhere else: Deployment > Production Updates posts the App
 * manifest to github.com, which is how GitHub's manifest flow works
 * (src/components/admin/github/create-app.tsx). Every other page keeps
 * `form-action 'self'`. Exact path match: nothing under it, and no other page.
 */
const FORM_ACTIONS_BY_PATH: ReadonlyMap<string, readonly string[]> = new Map([
  ["/admin/github", ["https://github.com"]],
]);

/** Where forms on the page at `pathname` may post, besides this origin. */
export function formActionsFor(pathname: string): readonly string[] {
  return FORM_ACTIONS_BY_PATH.get(pathname) ?? [];
}

/** A fresh nonce for one request. */
export function cspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
