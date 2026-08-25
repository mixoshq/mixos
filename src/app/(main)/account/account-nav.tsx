"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Plug, Settings, UserCog } from "lucide-react";

const items = [
  { label: "Account", href: "/account", icon: UserCog },
  { label: "Preferences", href: "/account/preferences", icon: Settings },
  { label: "My Connections", href: "/account/connections", icon: Plug },
  { label: "MCP Connections", href: "/account/mcp", icon: Bot },
];

export default function AccountNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col md:gap-0.5">
      {items.map((item) => {
        const active =
          pathname === item.href ||
          (item.href !== "/account" && pathname.startsWith(item.href));
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-mixnavy font-medium text-white"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
