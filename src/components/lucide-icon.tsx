"use client";

import { icons, type LucideProps } from "lucide-react";

interface LucideIconProps extends LucideProps {
  name: string;
}

/**
 * Render a Lucide icon by its kebab-case name (e.g., "bar-chart", "box").
 * Falls back to the Box icon if the name isn't found.
 */
export default function LucideIcon({ name, ...props }: LucideIconProps) {
  const pascalName = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

  const Icon = icons[pascalName as keyof typeof icons] ?? icons.Box;
  return <Icon {...props} />;
}
