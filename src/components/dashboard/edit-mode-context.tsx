/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

interface DashboardEditContextValue {
  isEditing: boolean;
  setIsEditing: (v: boolean) => void;
}

const DashboardEditContext = createContext<DashboardEditContextValue>({
  isEditing: false,
  setIsEditing: () => {},
});

export function DashboardEditProvider({ children }: { children: ReactNode }) {
  const [editRequested, setIsEditing] = useState(false);
  const pathname = usePathname();

  // Derived, not reset by an effect. Edit mode only means anything on the
  // dashboard, so leaving it is simply a render where the flag reads false —
  // no second render pass, and no state that can be briefly stale.
  const isEditing = pathname === "/" && editRequested;

  return (
    <DashboardEditContext.Provider value={{ isEditing, setIsEditing }}>
      {children}
    </DashboardEditContext.Provider>
  );
}

export function useDashboardEdit() {
  return useContext(DashboardEditContext);
}
