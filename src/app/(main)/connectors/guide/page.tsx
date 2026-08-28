/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import ConnectorGuideTabs from "@/components/connectors/connector-guide-tabs";

export default function ConnectorGuidePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <Link
          href="/admin/connectors"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; Back to Connector Registry
        </Link>
      </div>

      <h1 className="text-2xl font-bold">How to Create a Connector</h1>
      <p className="mt-2 text-muted-foreground">
        Connectors are reusable integrations with external services. They live
        in the{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-sm">
          /connectors
        </code>{" "}
        directory and can be shared across any app in the platform.
      </p>

      <div className="mt-4 rounded-md border border-primary/30 bg-primary/10 p-4 text-sm text-foreground">
        <p className="flex items-center gap-2 font-semibold">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
          Build with Claude Code
        </p>
        <p className="mt-1">
          Use the{" "}
          <code className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-mono">
            /mix-connector
          </code>{" "}
          slash command in Claude Code to scaffold or update a connector. It
          references all the documentation below to generate correct code.
        </p>
        <p className="mt-1.5 text-xs">
          Usage:{" "}
          <code className="rounded bg-primary/15 px-1 py-0.5 font-mono">
            /mix-connector create my-connector optional notes
          </code>
        </p>
      </div>

      <ConnectorGuideTabs />

      <p className="mt-12 text-center text-xs text-muted-foreground">
        Made in Detroit with 🫶🏽
      </p>
    </div>
  );
}
