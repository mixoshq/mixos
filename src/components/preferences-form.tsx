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
import { Card } from "./ui/card";

export default function PreferencesForm() {
  const { menuBar, menuBarAppDisplay, setMenuBar, setMenuBarAppDisplay } =
    usePreferences();

  return (
    // Half the settings content column, matching the Account card. See the note
    // there: full width below `md`.
    <Card className="mt-8 w-full space-y-6 p-4 shadow-sm md:w-1/2">
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
    </Card>
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
