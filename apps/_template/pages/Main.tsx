import { callAppRoute } from "@/lib/apps/call";
import { EmptyState } from "@/components/ui/app-states";
import { Card, CardBody } from "@/components/ui/card";

/**
 * A server component that renders from its own API route.
 *
 * THIS IS HOW A PAGE GETS DATA. It does not import a connector, the database,
 * or its own `lib/server` — all three are lint errors here, because reaching
 * them would skip the gateway entirely: no auth-tier resolution, no role gate,
 * no input or output validation, no connector budget, no telemetry.
 *
 * `callAppRoute` runs the identical pipeline in-process. Same everything a
 * browser calling `/api/apps/_template/hello` would get, minus the network hop
 * and the JSON round trip. It throws `AppError` rather than returning a
 * Response, so a page that would rather degrade than fail should catch it —
 * as this one does.
 */
export default async function TemplatePage() {
  let greeting: string | null = null;

  try {
    const data = await callAppRoute<{ message: string }>(
      "_template",
      "GET /hello",
      { shout: false },
    );
    greeting = data.message;
  } catch {
    // Degrade, don't fail: one unavailable route should cost the card, not the
    // page. See docs/apps/ux.md — every state gets a designed screen.
    greeting = null;
  }

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-foreground">Hello MixOS</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Rendered on the server, from this app&apos;s own declared route.
      </p>

      <Card className="mt-6">
        <CardBody>
          {greeting ? (
            <p className="text-lg text-card-foreground">{greeting}</p>
          ) : (
            <EmptyState
              cause="no-data"
              title="Nothing to greet yet"
              body="The hello route did not return anything. Check the server log for the reason."
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
