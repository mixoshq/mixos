/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import Header from "./header";
import { usePreferences } from "./preferences-context";
import { useTour } from "./onboarding/tour-context";

export default function HeaderShell({ logo }: { logo?: string | null }) {
  const { menuBar } = usePreferences();
  const { phase } = useTour();
  const [peek, setPeek] = useState(false);

  // The welcome tour flies the logo into this bar and then points at it; an
  // auto-hidden bar would leave both animations aimed at nothing. Inline
  // until the tour is over, then the preference applies again.
  const hidden = menuBar === "hidden" && phase === "done";
  const visible = !hidden || peek;

  if (!hidden) {
    return <Header logo={logo} />;
  }

  return (
    <>
      {/* Hover zone to reveal the hidden menu bar */}
      <div
        className="fixed left-0 right-0 top-0 z-40 h-2"
        onMouseEnter={() => setPeek(true)}
      />
      <div
        className={`fixed left-0 right-0 top-0 z-50 transition-transform duration-200 ease-in-out ${
          visible ? "translate-y-0" : "-translate-y-full"
        }`}
        onMouseEnter={() => setPeek(true)}
        onMouseLeave={() => setPeek(false)}
      >
        <Header logo={logo} />
      </div>
    </>
  );
}
