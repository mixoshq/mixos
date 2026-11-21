"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { EmptyState } from "@/components/ui/app-states";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { GREETINGS } from "../../lib/shared/greetings";

/**
 * The page a greeting found in global search opens: `/apps/<slug>/greetings?id=es`.
 *
 * App pages have literal paths (there is no `greetings/[id]`), so which record
 * to show arrives in the query string, as the search link in app.json puts it
 * there. Read it with `useSearchParams`, never `window.location`, or the server
 * and the browser render different pages (docs/apps/app-shell.md).
 */
export default function GreetingsPage() {
  const id = useSearchParams().get("id");
  const selected = id ? GREETINGS.find((g) => g.id === id) : undefined;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-foreground">Greetings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Find any of these from global search: press ⌘K and type a greeting or a language.
      </p>

      {id && !selected && (
        <div className="mt-6">
          <EmptyState
            cause="no-match"
            title="No greeting with that id"
            body="The link named a greeting this app doesn't have. Pick one below."
          />
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title="Every greeting" />
        <CardBody>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {GREETINGS.map((g) => (
              <li key={g.id}>
                <Link
                  href={`?id=${encodeURIComponent(g.id)}`}
                  aria-current={g.id === selected?.id ? "true" : undefined}
                  className={cn(
                    "block rounded-md border p-4 transition-colors",
                    g.id === selected?.id ? "border-primary" : "border-border hover:border-primary",
                  )}
                >
                  <span className="block text-lg font-medium text-foreground">{g.phrase}</span>
                  <span className="block text-sm text-muted-foreground">{g.language}</span>
                </Link>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
