"use client";

import { useState } from "react";
import Header from "./header";
import { usePreferences } from "./preferences-context";

export default function HeaderShell({ isLocal = false }: { isLocal?: boolean }) {
  const { menuBar } = usePreferences();
  const [peek, setPeek] = useState(false);

  const hidden = menuBar === "hidden";
  const visible = !hidden || peek;

  if (!hidden) {
    return <Header isLocal={isLocal} />;
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
        <Header isLocal={isLocal} />
      </div>
    </>
  );
}
