import { headers } from "next/headers";

/**
 * Hostnames that mean "this browser tab is pointed at the developer's own
 * machine". Ports are stripped before the lookup, so `localhost:3000` and
 * `[::1]:3000` both land here.
 */
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

/**
 * True when the current request was served to a browser on localhost.
 *
 * Deliberately host-based rather than `NODE_ENV`-based: a production build run
 * locally (`npm run build && npm start`) should still be flagged as local. The
 * flip side — a real deployment can never match, because its Host is its own
 * domain.
 *
 * Only the `Host` header is consulted, never `X-Forwarded-Host`: the latter is
 * client-supplied, and there is no reason to let a request talk the production
 * UI into wearing the local-development colours.
 *
 * Reads request headers, so a caller is opted into dynamic rendering. Every
 * page under `(main)` already reads the session cookie, so this is free there.
 */
export async function isLocalRequest(): Promise<boolean> {
  const hdrs = await headers();
  const hostname = (hdrs.get("host") ?? "")
    .toLowerCase()
    // "localhost:3000" → "localhost"; "[::1]:3000" → "[::1]"
    .replace(/:\d+$/, "");
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}
