/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useState, useTransition } from "react";
import type { AppManifest } from "@/lib/apps/types";
import type { AppSettingStatus } from "@/lib/apps/env";
import {
  clearAppSettingAction,
  getAppSettings,
  setAppSettingAction,
} from "@/lib/apps/settings-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status";

/**
 * The Settings tab of an app's details dialog: one row per setting the app
 * declares under `env`, which it reads as `context.env.<KEY>`.
 *
 * A `text` value is shown as stored, so it can be edited in place. A `password`
 * value is encrypted when saved and never sent back to the browser, so its
 * field starts empty and saving replaces it. Each row saves and clears on its
 * own: a blank field never means "erase", so nothing is lost by saving one
 * setting while another field happens to be empty.
 */
export default function AppSettingsPanel({ app }: { app: AppManifest }) {
  const [settings, setSettings] = useState<AppSettingStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const declares = app.env.length > 0;

  useEffect(() => {
    if (!declares) return;
    let live = true;
    getAppSettings(app.slug)
      .then((s) => live && setSettings(s))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.slug, declares]);

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Settings
      </h3>
      {!declares ? (
        <p className="mt-1 text-sm text-muted-foreground">
          This app declares no settings. An app asks for one under{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">env</code>{" "}
          in its app.json.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            Values this app reads as{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              context.env
            </code>
            . It sees only the settings it declares. A password is stored
            encrypted and is never shown again.
          </p>
          {loadError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              Could not read the settings: {loadError}
            </p>
          ) : settings === null ? (
            <p className="mt-3 text-sm text-muted-foreground">Loading settings…</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {settings.map((setting) => (
                <SettingRow
                  key={setting.key}
                  slug={app.slug}
                  setting={setting}
                  onChange={setSettings}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SettingRow({
  slug,
  setting,
  onChange,
}: {
  slug: string;
  setting: AppSettingStatus;
  onChange: (next: AppSettingStatus[]) => void;
}) {
  const isPassword = setting.type === "password";
  const [draft, setDraft] = useState(isPassword ? "" : (setting.value ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(work: () => Promise<void>, done: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await work();
        onChange(await getAppSettings(slug));
        setNotice(done);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the setting.");
      }
    });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (draft === "") {
      setNotice(null);
      setError("Enter a value, or clear the setting.");
      return;
    }
    run(async () => {
      await setAppSettingAction(slug, setting.key, draft);
      if (isPassword) setDraft("");
    }, "Saved. The app reads it from its next request.");
  }

  function clear() {
    run(async () => {
      await clearAppSettingAction(slug, setting.key);
      setDraft("");
    }, "Cleared. The app now reads it as unset.");
  }

  const hint = isPassword
    ? setting.set
      ? "Saved and encrypted. Enter a new value to replace it."
      : "Stored encrypted. Only the app can read it."
    : undefined;

  return (
    <li className="rounded-md border border-border p-4">
      <form onSubmit={save} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            {setting.key}
          </code>
          {setting.set ? (
            <StatusPill tone="success">
              Set
              {setting.updatedAt &&
                ` · ${new Date(setting.updatedAt).toLocaleDateString()}`}
            </StatusPill>
          ) : setting.required ? (
            <StatusPill tone="warning">Required, not set</StatusPill>
          ) : (
            <StatusPill tone="neutral">Not set</StatusPill>
          )}
        </div>
        <Field
          label={setting.label}
          hint={hint}
          error={error ?? undefined}
          required={setting.required}
        >
          {(args) => (
            <Input
              {...args}
              type={isPassword ? "password" : "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete={isPassword ? "new-password" : "off"}
              placeholder={isPassword && setting.set ? "••••••••" : undefined}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="sm" busy={pending} busyLabel="Saving…">
            Save
          </Button>
          {setting.set && (
            <Button type="button" size="sm" onClick={clear} disabled={pending}>
              Clear
            </Button>
          )}
          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
        </div>
      </form>
    </li>
  );
}
