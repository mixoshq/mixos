/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import PreferencesForm from "@/components/preferences-form";
import ReplayTourButton from "@/components/onboarding/replay-button";

export default function PreferencesPage() {
  return (
    <section>
      <h1 className="text-2xl font-bold text-foreground">Preferences</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Customize how MixOS looks and behaves for you.
      </p>
      <div className="mt-4">
        <PreferencesForm />
      </div>
      <ReplayTourButton />
    </section>
  );
}
