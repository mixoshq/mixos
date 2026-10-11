/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Browse renders, on the server: no Install & Activate, a pending
 * install's tile leading to its review, and a built deployment saying how
 * installing works, as information, in place of an install it would refuse.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { BUILT_DEPLOYMENT_NOTICE } from "@/lib/platform/build";
import ExtensionBrowser from "./extension-browser";
import ExtensionCard from "./extension-card";
import RegisterDialog from "./register-dialog";

/** The app router a page has, which the review dialog's refresh needs. Nothing navigates here. */
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
} as unknown as AppRouterInstance;
const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

test("a built deployment's Browse page says how installing works, as information", () => {
  const html = render(
    createElement(ExtensionBrowser, {
      kind: "app",
      repositoryOrigin: "https://mixos.org",
      repositoryOverridable: false,
      installedSlugs: [],
      pendingSlugs: [],
      installable: BUILT_DEPLOYMENT_NOTICE,
      installableTone: "info",
    }),
  );
  const notice = html.match(/<div role="status" data-tone="(\w+)"[^>]*>(.*?)<\/div><\/div><\/div>/);
  assert.ok(notice, "no notice");
  assert.equal(notice[1], "info");
  assert.equal(
    text(notice[2]).trim(),
    "This deployment runs a build. Install and register in a checkout of your repository, commit, and deploy.",
  );
  assert.doesNotMatch(html, /border-warning/);
  assert.doesNotMatch(text(html), /cannot|not writable/);
});

test("its install dialog shows the release and the same notice, without offering to install", () => {
  const html = render(
      createElement(RegisterDialog, {
        extension: {
          slug: "acme",
          kind: "app",
          name: "Acme Board",
          tagline: "",
          categories: [],
          keywords: [],
          author: { handle: "acme", verified: false },
          license: "MIT",
          installCount: 0,
          featured: false,
          latestVersion: "1.2.0",
        },
        notInstallable: { message: BUILT_DEPLOYMENT_NOTICE, tone: "info" },
        onClose: () => {},
        onInstalled: () => {},
        onReview: () => {},
      }),
  );
  const seen = text(html);
  assert.match(html, /data-tone="info"/);
  assert.ok(seen.includes(BUILT_DEPLOYMENT_NOTICE));
  assert.match(seen, /Close/);
  assert.doesNotMatch(seen, /Verify and install/);
});

test("Browse has no Install & Activate, and a pending install's tile leads to its review", () => {
  const extension = {
    slug: "acme",
    kind: "app" as const,
    name: "Acme Board",
    tagline: "Boards.",
    categories: [],
    keywords: [],
    author: { handle: "acme", verified: false },
    license: "MIT",
    installCount: 3,
    featured: false,
    latestVersion: "1.2.0",
  };
  const card = (pending: boolean) =>
    text(
      render(
        createElement(ExtensionCard, {
          extension,
          repositoryOrigin: "https://mixos.org",
          installedSlugs: new Set<string>(),
          pendingSlugs: new Set(pending ? ["acme"] : []),
          onInstall: () => {},
          onReview: () => {},
        }),
      ),
    );
  assert.doesNotMatch(card(false), /Activate/);
  assert.match(card(false), /\bInstall\b/);
  assert.match(card(true), /Review and register/);
  assert.doesNotMatch(card(true), /\bInstall\b(?!s)/);
});
