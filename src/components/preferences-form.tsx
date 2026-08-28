/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  usePreferences,
  type MenuBarMode,
  type MenuBarAppDisplay,
} from "./preferences-context";
import NotificationsPreference from "./notifications-preference";

export default function PreferencesForm() {
  const { menuBar, menuBarAppDisplay, setMenuBar, setMenuBarAppDisplay } =
    usePreferences();

  return (
    <div className="mt-8 space-y-6 rounded-lg border border-border bg-card p-6">
      <Field
        label="Menu Bar"
        description="Always show the top menu bar, or auto-hide it until you hover the top of the screen."
        value={menuBar}
        options={[
          { value: "always", label: "Always show" },
          { value: "hidden", label: "Hidden (hover to reveal)" },
        ]}
        onChange={(v) => setMenuBar(v as MenuBarMode)}
      />

      <Field
        label="Menu Bar Apps"
        description="Show pinned apps in the menu bar as icon only, or icon plus name."
        value={menuBarAppDisplay}
        options={[
          { value: "icon-and-name", label: "Icon + Name" },
          { value: "icon", label: "Icon only" },
        ]}
        onChange={(v) => setMenuBarAppDisplay(v as MenuBarAppDisplay)}
      />

      <NotificationsPreference />

      <div className="border-t border-border pt-6">
        <div className="mb-1 text-sm font-medium text-foreground">
          Chrome Extension
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Replace your Chrome new tab page with MixOS. Click the toolbar icon
          to toggle the privacy filter, which covers the screen so your data
          stays hidden while you&apos;re screensharing.
        </p>

        <a
          href="/mixos-extension.zip"
          download
          className="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download Extension
        </a>

        <div className="mt-4 rounded-md border border-border bg-muted/50 p-4 text-xs text-muted-foreground space-y-2">
          <p className="font-medium text-foreground">How to install</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Download the extension zip above and unzip it</li>
            <li>
              Open{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                chrome://extensions
              </code>{" "}
              in Chrome
            </li>
            <li>
              Enable{" "}
              <strong className="font-semibold text-foreground">
                Developer mode
              </strong>{" "}
              (top-right toggle)
            </li>
            <li>
              Click{" "}
              <strong className="font-semibold text-foreground">
                Load unpacked
              </strong>{" "}
              and select the unzipped folder
            </li>
            <li>
              Open a new tab — MixOS loads inside the tab, and the address
              bar stays focused so you can keep typing
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  description: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  trailing?: React.ReactNode;
}

function Field({
  label,
  description,
  value,
  options,
  onChange,
  trailing,
}: FieldProps) {
  return (
    <div>
      <div className="mb-1 text-sm font-medium text-foreground">{label}</div>
      <p className="mb-2 text-xs text-muted-foreground">{description}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                onClick={() => onChange(opt.value)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-brand text-brand-foreground"
                    : "bg-card text-foreground hover:bg-accent"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {trailing}
      </div>
    </div>
  );
}
