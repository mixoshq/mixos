import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { isConnectorConfigured } from "@/lib/connectors/config";

/**
 * UX gate that pre-empts confusing runtime failures by refusing to register an
 * app whose connector dependencies are not actually usable yet. This is not a
 * security boundary — runtime widgets and routes still degrade gracefully if
 * state changes after registration.
 *
 * Returned shape uses {name, displayName} so callers can render readable
 * warnings without re-resolving the registry.
 */

interface MissingConnector {
  name: string;
  displayName: string;
}

function lookupConnector(name: string): { displayName: string } | null {
  const c = connectorRegistry.find((c) => c.name === name);
  if (!c) return null;
  return { displayName: c.displayName };
}

/**
 * Connectors declared by the app whose credentials (`connector_configs` row)
 * an admin has not entered yet.
 *
 * Connector names declared in app.json that aren't in the registry at all
 * are reported as missing with displayName === name, so the admin sees
 * something actionable rather than silently passing the gate.
 */
export async function getMissingTenantConfigConnectors(
  appSlug: string,
): Promise<MissingConnector[]> {
  const app = appRegistry.find((a) => a.slug === appSlug);
  if (!app) return [];

  const checks = await Promise.all(
    app.connectors.map(async (name) => {
      const meta = lookupConnector(name);
      const configured = await isConnectorConfigured(name);
      if (!configured) {
        return {
          name,
          displayName: meta?.displayName ?? name,
        };
      }
      return null;
    }),
  );

  return checks.filter((c): c is MissingConnector => c !== null);
}

/** Format a list of missing connectors as a comma-separated display string. */
export function formatMissingList(missing: MissingConnector[]): string {
  return missing.map((m) => m.displayName).join(", ");
}
