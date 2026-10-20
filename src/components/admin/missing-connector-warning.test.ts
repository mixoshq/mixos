/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The not-ready-connector warning on an app's tile and Overview, rendered on
 * the server: worded for an inactive app, which can't be activated or granted
 * yet, and for an active one, which is running without the connector.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppManifest } from "@/lib/apps/types";
import type { MissingConnector } from "@/lib/apps/connector-readiness";
import { MissingConnectorWarning } from "./app-details-dialog";

/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();

const app = { slug: "crm", name: "CRM Check" } as AppManifest;

const CRM: MissingConnector = { name: "crm", displayName: "Verify CRM", state: "needs-authorization" };
const DRIVE: MissingConnector = { name: "drive", displayName: "Drive", state: "unconfigured" };
const MAIL: MissingConnector = { name: "mail", displayName: "Mail", state: "unconfigured" };
const FEED: MissingConnector = { name: "feed", displayName: "Feed", state: "disabled" };
const SHEETS: MissingConnector = { name: "sheets", displayName: "Sheets", state: "read-only" };

const warning = (missingConnectors: MissingConnector[], isActive: boolean) =>
  text(renderToStaticMarkup(createElement(MissingConnectorWarning, { app, missingConnectors, isActive })));

test("an inactive app can't be activated or granted until each connector is ready", () => {
  assert.equal(
    warning([CRM], false),
    "CRM Check can't be activated or granted until Verify CRM is connected. Open Connector Registry →",
  );
  assert.equal(
    warning([DRIVE, MAIL, FEED], false),
    "CRM Check can't be activated or granted until Drive and Mail are configured and Feed is enabled. Open Connector Registry →",
  );
});

test("an active app is running without them: it can't be granted, and what needs them fails", () => {
  assert.equal(
    warning([CRM], true),
    "CRM Check is active, but Verify CRM isn't connected, so it can't be granted to anyone, and anything that needs that connector fails. Open Connector Registry →",
  );
  assert.equal(
    warning([DRIVE, MAIL, FEED], true),
    "CRM Check is active, but Drive and Mail aren't configured and Feed isn't enabled, so it can't be granted to anyone, and anything that needs those connectors fails. Open Connector Registry →",
  );
});

test("an app that changes data waits on its connector being allowed to", () => {
  assert.equal(
    warning([SHEETS], false),
    "CRM Check can't be activated or granted until Sheets is allowed to change data. Open Connector Registry →",
  );
  assert.equal(
    warning([SHEETS], true),
    "CRM Check is active, but Sheets isn't allowed to change data, so it can't be granted to anyone, and anything that needs that connector fails. Open Connector Registry →",
  );
});
