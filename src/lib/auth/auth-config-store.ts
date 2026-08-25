import { createServiceClient } from "@/lib/db/server";
import { encrypt, decrypt } from "@/lib/connectors/encryption";

export interface AuthConfig {
  ssoEnabled: boolean;
  oidcIssuerUrl: string | null;
  oidcClientId: string | null;
  oidcClientSecret: string | null;
  adminClaimName: string | null;
  adminClaimValues: string[];
}

export interface AuthConfigSummary {
  ssoEnabled: boolean;
  oidcIssuerUrl: string | null;
  oidcClientId: string | null;
  hasClientSecret: boolean;
  adminClaimName: string | null;
  adminClaimValues: string[];
}

const SELECT_COLUMNS =
  "sso_enabled, oidc_issuer_url, oidc_client_id, oidc_client_secret_encrypted, admin_claim_name, admin_claim_values";

export async function getAuthConfig(): Promise<AuthConfig> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("auth_config")
    .select(SELECT_COLUMNS)
    .eq("id", 1)
    .maybeSingle();

  if (!data) {
    return {
      ssoEnabled: false,
      oidcIssuerUrl: null,
      oidcClientId: null,
      oidcClientSecret: null,
      adminClaimName: null,
      adminClaimValues: [],
    };
  }

  let clientSecret: string | null = null;
  if (data.oidc_client_secret_encrypted) {
    try {
      clientSecret = decrypt(data.oidc_client_secret_encrypted);
    } catch {
      clientSecret = null;
    }
  }

  return {
    ssoEnabled: !!data.sso_enabled,
    oidcIssuerUrl: data.oidc_issuer_url ?? null,
    oidcClientId: data.oidc_client_id ?? null,
    oidcClientSecret: clientSecret,
    adminClaimName: data.admin_claim_name ?? null,
    adminClaimValues: Array.isArray(data.admin_claim_values)
      ? (data.admin_claim_values as string[])
      : [],
  };
}

export async function getAuthConfigSummary(): Promise<AuthConfigSummary> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("auth_config")
    .select(SELECT_COLUMNS)
    .eq("id", 1)
    .maybeSingle();

  return {
    ssoEnabled: !!data?.sso_enabled,
    oidcIssuerUrl: data?.oidc_issuer_url ?? null,
    oidcClientId: data?.oidc_client_id ?? null,
    hasClientSecret: !!data?.oidc_client_secret_encrypted,
    adminClaimName: data?.admin_claim_name ?? null,
    adminClaimValues: Array.isArray(data?.admin_claim_values)
      ? (data.admin_claim_values as string[])
      : [],
  };
}

export async function isSsoEnabled(): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("auth_config")
    .select("sso_enabled, oidc_issuer_url, oidc_client_id, oidc_client_secret_encrypted")
    .eq("id", 1)
    .maybeSingle();

  if (!data?.sso_enabled) return false;
  return (
    !!data.oidc_issuer_url &&
    !!data.oidc_client_id &&
    !!data.oidc_client_secret_encrypted
  );
}

export async function setSsoConfig(args: {
  issuerUrl: string;
  clientId: string;
  clientSecret: string | null;
  adminClaimName: string | null;
  adminClaimValues: string[];
  updatedByUserId: string;
}): Promise<void> {
  const supabase = createServiceClient();

  const update: Record<string, unknown> = {
    oidc_issuer_url: args.issuerUrl,
    oidc_client_id: args.clientId,
    admin_claim_name: args.adminClaimName,
    admin_claim_values: args.adminClaimValues,
    updated_by: args.updatedByUserId,
    updated_at: new Date().toISOString(),
  };

  if (args.clientSecret !== null) {
    update.oidc_client_secret_encrypted = encrypt(args.clientSecret);
  }

  const { error } = await supabase
    .from("auth_config")
    .update(update)
    .eq("id", 1);

  if (error) throw new Error(`Failed to save auth config: ${error.message}`);
}

export async function setSsoEnabled(args: {
  enabled: boolean;
  updatedByUserId: string;
}): Promise<void> {
  if (args.enabled) {
    const summary = await getAuthConfigSummary();
    if (
      !summary.oidcIssuerUrl ||
      !summary.oidcClientId ||
      !summary.hasClientSecret
    ) {
      throw new Error(
        "SSO cannot be enabled until the OIDC issuer, client ID, and client secret are configured."
      );
    }
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("auth_config")
    .update({
      sso_enabled: args.enabled,
      updated_by: args.updatedByUserId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) throw new Error(`Failed to toggle SSO: ${error.message}`);
}
