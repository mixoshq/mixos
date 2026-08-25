"use client";

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
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
  const [isEditing, setIsEditing] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== "/") {
      setIsEditing(false);
    }
  }, [pathname]);

  return (
    <DashboardEditContext.Provider value={{ isEditing, setIsEditing }}>
      {children}
    </DashboardEditContext.Provider>
  );
}

export function useDashboardEdit() {
  return useContext(DashboardEditContext);
}
