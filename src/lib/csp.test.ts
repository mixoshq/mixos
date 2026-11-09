/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsp, formActionsFor } from "./csp";

const formAction = (csp: string) => csp.split("; ").find((d) => d.startsWith("form-action "));

test("forms post only to this origin, on every page but one", () => {
  assert.equal(formAction(buildCsp("n")), "form-action 'self'");
  for (const path of ["/", "/admin", "/admin/apps", "/admin/github/x", "/admin/githubx", "/admin/GitHub", "/api/admin/github/created"]) {
    assert.deepEqual(formActionsFor(path), [], path);
    assert.equal(formAction(buildCsp("n", { formActions: formActionsFor(path) })), "form-action 'self'", path);
  }
});

test("Developers > GitHub App may also post to github.com, where GitHub's manifest flow starts", () => {
  assert.deepEqual(formActionsFor("/admin/github"), ["https://github.com"]);
  assert.equal(
    formAction(buildCsp("n", { formActions: formActionsFor("/admin/github") })),
    "form-action 'self' https://github.com",
  );
});
