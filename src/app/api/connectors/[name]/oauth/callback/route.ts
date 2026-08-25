import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { connectorRegistry } from "@/generated/connector-registry";
import { getDecryptedConfig, saveConnectorTokens } from "@/lib/connectors/config";
import { isConnectorError } from "@/lib/connectors/errors";
import {
  OAUTH_STATE_COOKIE,
  exchangeAuthorizationCode,
  openFlowState,
  stateMatches,
} from "@/lib/connectors/oauth";

/**
 * Finish the tenant OAuth consent flow: verify the round trip, exchange the
 * code, and merge the resulting tokens into the connector's encrypted
 * credentials.
 *
 * Outcomes are reported to the admin as a coarse `?oauth=` status, never as the
 * provider's own error text — those bodies routinely name the tenant, the
 * account, and occasionally the credential.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const { name } = await ctx.params;
  const flow = openFlowState(request.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const returnTo = flow?.returnTo ?? "/admin/connectors";

  const finish = (status: string) => {
    const response = NextResponse.redirect(
      new URL(
        `${returnTo}?connector=${encodeURIComponent(name)}&oauth=${status}`,
        request.nextUrl.origin,
      ),
    );
    // One-shot: the flow cookie never outlives the round trip it authorises.
    response.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/connectors" });
    return response;
  };

  // An absent or stale cookie means the flow expired, the key rotated, or this
  // callback was reached without a matching start. All are "begin again".
  if (!flow || flow.connector !== name) return finish("expired");

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return finish("denied");

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !stateMatches(state, flow.state)) return finish("state");

  const connector = connectorRegistry.find((c) => c.name === name);
  const policy = connector?.auth;
  if (!connector || policy?.strategy !== "oauth2_authorization_code") {
    return finish("unsupported");
  }

  const [idKey, secretKey] = policy.credentialKeys ?? ["clientId", "clientSecret"];
  const credentials = (await getDecryptedConfig(name)) ?? {};

  try {
    const tokens = await exchangeAuthorizationCode({
      policy,
      connectorName: name,
      subject: connector.displayName,
      clientId: credentials[idKey] ?? "",
      clientSecret: credentials[secretKey] ?? "",
      code,
      codeVerifier: flow.codeVerifier,
    });
    await saveConnectorTokens(name, tokens);
  } catch (err) {
    // Log our own classification only — never the upstream body.
    console.error(
      `[connector-oauth] ${name} code exchange failed:`,
      isConnectorError(err) ? `${err.category} (HTTP ${err.status})` : err,
    );
    return finish("exchange-failed");
  }

  revalidatePath("/admin/connectors");
  return finish("connected");
}
