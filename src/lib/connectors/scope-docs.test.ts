/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScopeDocs } from "./scope-docs";

/** A one-table page from rows of raw cell HTML. */
const page = (...rows: string[][]) =>
  `<html><body><table>${rows
    .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("\n")}</table></body></html>`;

const scopes = (html: string) => parseScopeDocs(html).map((s) => s.scope);

// ── scopes that are URLs ────────────────────────────────────────────────────

test("a scope URL is read as before, in whichever cell it sits", () => {
  const parsed = parseScopeDocs(
    page(
      ['<code>https://www.googleapis.com/auth/gmail.readonly</code>', "View your email messages and settings."],
      ["Read, compose, send, and permanently delete all your email from Gmail.", "https://mail.google.com/"],
    ),
  );
  assert.deepEqual(parsed, [
    {
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      description: "View your email messages and settings.",
      access: "read",
    },
    {
      scope: "https://mail.google.com/",
      description: "Read, compose, send, and permanently delete all your email from Gmail.",
      access: "read-write",
    },
  ]);
});

test("a line-break hint inside a scope URL does not split it", () => {
  assert.deepEqual(
    scopes(
      page([
        "<code>https://www.<wbr>googleapis.<wbr>com/<wbr>auth/<wbr>cloud-platform</code>",
        "See, edit, configure, and delete your Google Cloud data.",
      ]),
    ),
    ["https://www.googleapis.com/auth/cloud-platform"],
  );
});

// ── scopes that are names ───────────────────────────────────────────────────

test("a scope that is a name is read: the OAuth template's own, Slack's, Atlassian's", () => {
  assert.deepEqual(
    scopes(
      page(
        ["<code>things:read</code>", "View your things"],
        ['<a href="/scopes/channels:read">channels:read</a>', "View basic information about public channels in a workspace"],
        ["read:jira-work", "Read Jira project and issue data, search for issues."],
        ["<code>Mail.ReadWrite</code>", "Allows the app to create, read, update, and delete email in user mailboxes."],
        ["<code>read_products</code>", "Products, variants, and collections."],
        ["<code>crm.objects.contacts.read</code>", "View properties and other details about contacts."],
      ),
    ),
    [
      "things:read",
      "channels:read",
      "read:jira-work",
      "Mail.ReadWrite",
      "read_products",
      "crm.objects.contacts.read",
    ],
  );
});

test("a bare word counts when the page sets it as code in the first cell", () => {
  const parsed = parseScopeDocs(
    page(
      ["<strong><code>repo</code></strong>", "Grants full access to public and private repositories."],
      ["<code>gist</code>", "Grants write access to gists."],
    ),
  );
  assert.deepEqual(
    parsed.map((s) => [s.scope, s.access]),
    [
      ["repo", "read-write"],
      ["gist", "write"],
    ],
  );
});

// ── what a scope table also holds ───────────────────────────────────────────

test("a header row, plain words and prose are not scopes", () => {
  assert.deepEqual(
    scopes(
      `<table><tr><th>Scope</th><th>Description</th></tr>` +
        `<tr><td>Delegated</td><td>Allows the app to read mail.</td></tr>` +
        `<tr><td>N/A</td><td>Read/Write</td><td>Not applicable to this API at all.</td></tr>` +
        `<tr><td><code>(no scope)</code></td><td>Grants read-only access to public information.</td></tr>` +
        `<tr><td>d07a8cc0-3d51-4b77-b3b0-32704d1f69fa</td><td>An identifier for the permission.</td></tr></table>`,
    ),
    [],
  );
});

test("a word set as code further along a row is not taken for the scope", () => {
  // Shopify lists two scopes in one cell beside the object they grant: the
  // object name is code, but it is not a scope.
  assert.deepEqual(
    scopes(
      page([
        "<p><code>read_carts</code></p><p><code>write_carts</code></p>",
        "<code>Cart</code>",
      ]),
    ),
    [],
  );
});

test("a scope listed twice keeps its first description", () => {
  const parsed = parseScopeDocs(
    page(
      ["<code>chat:write</code>", "Send messages as the app."],
      ["<code>chat:write</code>", "See the chat:write scope above."],
    ),
  );
  assert.deepEqual(parsed, [
    { scope: "chat:write", description: "Send messages as the app.", access: "write" },
  ]);
});
