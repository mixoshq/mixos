/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The escape suite's catalogue (Item 9): every known way an app or a
 * connector might try to get past what MixOS holds it to, what happens on each
 * host tier, the threat-model row it backs, and the test that shows it.
 *
 * Outcomes:
 *
 *   - `refused-at-build`: the build (the containment scan, the manifest
 *     schema) won't register code that tries it;
 *   - `refused-at-runtime`: the platform refuses it as it runs;
 *   - `contained`: it runs, and reaches nothing it shouldn't;
 *   - `known-limit`: it gets through, on this tier, as the threat model says.
 *     Its test pins the limit, so the day it changes the test does, and the
 *     threat model is updated with it.
 *
 * catalogue.test.ts checks that every test named here exists, and that every
 * label's escapes (src/lib/apps/labels.ts) are cases here, so the threat
 * model, the labels and the tests can't drift apart. CI runs the whole suite
 * against Postgres on every pull request.
 */

export type Outcome = "refused-at-build" | "refused-at-runtime" | "contained" | "known-limit";

export interface EscapeCase {
  id: string;
  /** What the hostile code tries. */
  attempt: string;
  /**
   * What happens, on each tier. "isolated" is the out-of-process tier: built
   * for connectors (src/lib/runners/remote-connector.ts), not yet for apps.
   */
  outcome: { inProcess: Outcome; isolated: Outcome | "not-built" };
  /** The row of docs/threat-model.md it backs. */
  threatModelRow: string;
  /** Where it is shown: a test file and a test's name in it. */
  tests: Array<{ file: string; name: string }>;
}

const APP_ROW = "An app's code is malicious or compromised";
const TOKEN_ROW = "A shared connector token is stolen";
const ROUTE_ROW = "A route in an app has a bug";

export const ESCAPES: EscapeCase[] = [
  {
    id: "manifest-write",
    attempt: "Write to context.manifest to widen its own egress, connectors or global flag",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      {
        file: "tests/escapes/context-reach.integration.test.ts",
        name: "an app can't widen its own manifest: egress, connectors and global stay as reviewed",
      },
    ],
  },
  {
    id: "connector-credentials",
    attempt: "Read a connector's decrypted credentials off the object an app is handed",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: TOKEN_ROW,
    tests: [
      {
        file: "tests/escapes/context-reach.integration.test.ts",
        name: "a connector's credentials are out of reach on every context an app is handed",
      },
      { file: "src/lib/apps/connector-reach.test.ts", name: "nothing that walks the object reaches the connector" },
    ],
  },
  {
    id: "connector-request",
    attempt: "Call the connector's protected request() to send any verb to any path with its credential",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: TOKEN_ROW,
    tests: [
      {
        file: "src/lib/apps/connector-reach.test.ts",
        name: "nothing the manifest doesn't declare can be called, request() above all",
      },
    ],
  },
  {
    id: "connector-undeclared-write",
    attempt: "Call a connector method that changes data without asking for write in app.json",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: TOKEN_ROW,
    tests: [
      {
        file: "src/lib/apps/connector-reach.test.ts",
        name: "an app whose entry doesn't ask for write is refused the write, as its own bug",
      },
    ],
  },
  {
    id: "services-impersonation",
    attempt: "Ask another app's service as someone else, by editing context.user",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      { file: "tests/escapes/context-reach.integration.test.ts", name: "an app can't ask another app's service as someone else" },
    ],
  },
  {
    id: "other-app-schema",
    attempt: "Query another app's tables, or the platform's, through context.db",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      {
        file: "tests/escapes/app-database.integration.test.ts",
        name: "SQL that reaches anything outside the app's schema is refused by Postgres",
      },
    ],
  },
  {
    id: "reset-role",
    attempt: "RESET ROLE, SET ROLE or set_config('role') to get back to the platform's login",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      {
        file: "tests/escapes/app-database.integration.test.ts",
        name: "SQL written to escape the app's role is refused, and leaves nothing behind",
      },
    ],
  },
  {
    id: "mcp-write",
    attempt: "Change data from an MCP tool or a search handler",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      { file: "src/lib/apps/read-only.test.ts", name: "a method declared mutates throws, and nothing is sent" },
      {
        file: "tests/escapes/app-database.integration.test.ts",
        name: "a read-only client stays read-only, whatever its SQL says",
      },
    ],
  },
  {
    id: "egress-undeclared",
    attempt: "Reach a host the app's egress doesn't list, through context.http",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      {
        file: "src/lib/apps/detection.integration.test.ts",
        name: "context.http records each refusal: a host it doesn't list, a scheme, a private address",
      },
    ],
  },
  {
    id: "redirect-ssrf",
    attempt: "Redirect, or resolve a declared host, to a private or metadata address",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      { file: "src/lib/apps/http.test.ts", name: "a redirect is handed back, not followed" },
      { file: "src/lib/apps/http.test.ts", name: "an allowed name that resolves to loopback is refused" },
      { file: "src/lib/apps/http.test.ts", name: "every answer is checked, and one private answer refuses the lot" },
    ],
  },
  {
    id: "raw-network",
    attempt: "Use fetch, a socket or an HTTP client package past context.http",
    outcome: { inProcess: "refused-at-build", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [{ file: "scripts/app-containment.test.ts", name: "an erased declaration does not hide a global" }],
  },
  {
    id: "function-by-reflection",
    attempt: "Reach Function through .constructor, and from it process",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      { file: "scripts/app-containment.test.ts", name: "the escape it closes: Function by reflection, then process" },
      {
        file: "src/lib/platform/reflection-lock.test.ts",
        name: "after it, every route to Function by reflection throws, naming why",
      },
    ],
  },
  {
    id: "global-process",
    attempt: "Read process off the global object, or hand the global object on",
    outcome: { inProcess: "refused-at-build", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [{ file: "scripts/app-containment.test.ts", name: "the global object is read by name, never handed on" }],
  },
  {
    id: "shared-module-pollution",
    attempt: "Patch a shared platform module, or Object.prototype, from app code",
    outcome: { inProcess: "refused-at-build", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      {
        file: "scripts/app-containment.test.ts",
        name: "property writes and the Object/Reflect writers, through an imported binding",
      },
    ],
  },
  {
    id: "public-tier",
    attempt: "Call a route through a tier it doesn't declare, as an anonymous visitor",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: ROUTE_ROW,
    tests: [{ file: "tests/escapes/catalogue.test.ts", name: "a route that declares only sessions isn't served to the public" }],
  },
  {
    id: "secrets-in-env",
    attempt: "Read the server's secrets from process.env",
    outcome: { inProcess: "refused-at-runtime", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      {
        file: "src/lib/env/secrets.test.ts",
        name: "the scrub takes every secret out of process.env; the platform still reads its own",
      },
    ],
  },
  {
    id: "pool-on-global",
    attempt: "Use the platform's database pool off the global object",
    outcome: { inProcess: "known-limit", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [{ file: "tests/escapes/known-limits.integration.test.ts", name: "the platform's pool is on the global object" }],
  },
  {
    id: "connector-reads-another",
    attempt: "A connector's own code reads another connector's credentials",
    outcome: { inProcess: "known-limit", isolated: "contained" },
    threatModelRow: TOKEN_ROW,
    tests: [
      {
        file: "tests/escapes/known-limits.integration.test.ts",
        name: "a connector's own code can read another connector's credentials",
      },
      { file: "src/lib/runners/remote-connector.test.ts", name: "the bundle carries this connector alone, and no database" },
      { file: "src/lib/runners/supervisor.test.ts", name: "every way out the permission model and the bootstrap close is closed" },
    ],
  },
  {
    id: "platform-login",
    attempt: "Use the platform's own database login, which reaches every app's tables",
    outcome: { inProcess: "known-limit", isolated: "not-built" },
    threatModelRow: APP_ROW,
    tests: [
      { file: "tests/escapes/app-database.integration.test.ts", name: "the limit: the platform's own login reaches every app's tables" },
    ],
  },
];
