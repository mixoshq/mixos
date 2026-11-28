/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { Link2, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import type { CredentialField } from "@/lib/connectors/types";
import type { OwnCredentialStatus } from "@/lib/connectors/reach";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";

/** The page's server actions for an app's own credentials, each re-checking the admin. */
export interface AppCredentialActions {
  /** Save what was typed for the app named in the form; whether it now holds a usable set. */
  configure: (formData: FormData) => Promise<boolean>;
  test: (connectorName: string, appSlug: string) => Promise<ConnectorTestOutcome>;
  /** Take its own credentials away: it uses the shared ones again. */
  remove: (connectorName: string, appSlug: string) => Promise<void>;
}

/** Words for how far an app's own credentials are set up, for its row's pill. */
export const OWN_STATE_LABEL: Record<OwnCredentialStatus["state"], string> = {
  ready: "Own credentials",
  "needs-authorization": "Own credentials · not connected",
  unconfigured: "Own credentials · incomplete",
  unreadable: "Own credentials · unreadable",
};

/**
 * One app's own credentials for a tenant connector, opened from its row in
 * the Reach section: the fields, Connect for OAuth, Verify, and the way back
 * to the shared credentials. Inline rather than a second dialog, so there is
 * one focus trap, and the row it is about stays in view.
 *
 * What it says first is what an admin most needs to know before saving: these
 * replace the shared credentials for this app everywhere, and nothing falls
 * back to the shared ones when they stop working.
 */
export default function AppCredentialsPanel({
  connectorName,
  connectorDisplayName,
  appSlug,
  appName,
  fields,
  isOAuth,
  own,
  actions,
}: {
  connectorName: string;
  connectorDisplayName: string;
  appSlug: string;
  appName: string;
  fields: CredentialField[];
  isOAuth: boolean;
  /** Its own credentials as they stand, or undefined when it uses the shared ones. */
  own: OwnCredentialStatus | undefined;
  actions: AppCredentialActions;
}) {
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const [removing, startRemove] = useTransition();
  const [outcome, setOutcome] = useState<ConnectorTestOutcome | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const saved = own !== undefined;
  const formId = `own-credentials-${connectorName}-${appSlug}`;
  const returnTo = `/admin/connectors?connector=${connectorName}&app=${appSlug}`;

  return (
    <div className="mt-2 space-y-3 rounded-md border border-border bg-background p-3">
      <p className="text-sm text-muted-foreground">
        {appName} uses these instead of the shared credentials, wherever its code reaches{" "}
        {connectorDisplayName}. Give it a narrower key or account, so it can do only what it needs at
        the provider. If they stop working, it doesn&apos;t fall back to the shared ones. Webhooks,
        Disable and Allow changes stay shared.
      </p>

      {own?.state === "unreadable" && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          Its credentials can&apos;t be decrypted, so {appName} has {connectorDisplayName} unconfigured.
          Enter them again, or use the shared credentials.
        </p>
      )}

      {fields.length > 0 && (
        <form
          id={formId}
          action={(formData) =>
            startSave(async () => {
              await actions.configure(formData);
            })
          }
          className="space-y-3"
        >
          <input type="hidden" name="connectorName" value={connectorName} />
          <input type="hidden" name="appSlug" value={appSlug} />
          {fields.map((field) => (
            <Field
              key={field.key}
              label={field.label}
              required={!saved}
              hint={saved ? "Already saved. Leave blank to keep the current value." : undefined}
            >
              {(args) => (
                <input
                  {...args}
                  type={field.type === "password" ? "password" : "text"}
                  name={field.key}
                  required={!saved}
                  autoComplete="off"
                  placeholder={saved ? "••••••••" : `Enter ${field.label}`}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </Field>
          ))}
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {fields.length > 0 && (
          <Button type="submit" form={formId} variant="primary" size="sm" busy={saving} busyLabel="Saving…">
            {saved ? "Update its credentials" : "Save its credentials"}
          </Button>
        )}
        {isOAuth && saved && (
          <a
            href={`/api/connectors/${encodeURIComponent(connectorName)}/oauth/start?app=${encodeURIComponent(
              appSlug,
            )}&return=${encodeURIComponent(returnTo)}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-foreground shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Link2 className="h-4 w-4" aria-hidden />
            {own?.state === "ready" ? "Reconnect its account" : "Connect its account"}
          </a>
        )}
        {saved && (
          <Button
            variant="secondary"
            size="sm"
            busy={testing}
            busyLabel="Testing…"
            icon={<PlugZap className="h-4 w-4" aria-hidden />}
            onClick={() =>
              startTest(async () => {
                setOutcome(await actions.test(connectorName, appSlug));
              })
            }
          >
            Verify its connection
          </Button>
        )}
        {saved &&
          (confirmingRemove ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                busy={removing}
                busyLabel="Removing…"
                onClick={() =>
                  startRemove(async () => {
                    await actions.remove(connectorName, appSlug);
                    setConfirmingRemove(false);
                    setOutcome(null);
                  })
                }
              >
                Delete its credentials
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)}>
                Keep them
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(true)}>
              Use the shared credentials
            </Button>
          ))}
      </div>

      {confirmingRemove && (
        <p className="text-sm text-muted-foreground">
          {appName}&apos;s own credentials are deleted, and it uses the shared ones from its next request.
          Revoke them at the provider too if nothing else uses them.
        </p>
      )}

      {outcome && (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm text-foreground ${
            outcome.ok ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10"
          }`}
        >
          {outcome.ok
            ? `Connected with ${appName}'s own credentials${outcome.detail ? ` — ${outcome.detail}` : ""}.`
            : outcome.message}
        </p>
      )}
    </div>
  );
}
