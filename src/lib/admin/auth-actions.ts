"use server";

import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import {
  setSsoConfig,
  setSsoEnabled,
  getAuthConfigSummary,
} from "@/lib/auth/auth-config-store";
import { safeErrorMessage } from "@/lib/safe-error";
import type { SsoConfigState } from "./auth-actions-types";

export async function saveSsoConfig(
  _prev: SsoConfigState,
  formData: FormData
): Promise<SsoConfigState> {
  try {
    const session = await requireReadOnlySession();
    await requireAdmin(session);

    const issuerUrl = String(formData.get("issuerUrl") ?? "").trim();
    const clientId = String(formData.get("clientId") ?? "").trim();
    const clientSecretRaw = String(formData.get("clientSecret") ?? "");
    // Empty string means "keep existing secret"; only overwrite when the
    // admin actually types something new.
    const clientSecret = clientSecretRaw === "" ? null : clientSecretRaw;

    const adminClaimNameRaw = String(
      formData.get("adminClaimName") ?? ""
    ).trim();
    const adminClaimName = adminClaimNameRaw === "" ? null : adminClaimNameRaw;

    const adminClaimValues = String(formData.get("adminClaimValues") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);

    if (!issuerUrl || !clientId) {
      return {
        error: "Issuer URL and client ID are required.",
        success: null,
      };
    }
    try {
      new URL(issuerUrl);
    } catch {
      return { error: "Issuer URL is not a valid URL.", success: null };
    }

    await setSsoConfig({
      issuerUrl,
      clientId,
      clientSecret,
      adminClaimName,
      adminClaimValues,
      updatedByUserId: session.user.id,
    });

    revalidatePath("/admin/authentication");
    return { error: null, success: "SSO configuration saved." };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to save SSO configuration."),
      success: null,
    };
  }
}

export async function toggleSso(
  _prev: SsoConfigState,
  formData: FormData
): Promise<SsoConfigState> {
  try {
    const session = await requireReadOnlySession();
    await requireAdmin(session);

    const target = formData.get("enabled") === "on";

    if (target) {
      const summary = await getAuthConfigSummary();
      if (
        !summary.oidcIssuerUrl ||
        !summary.oidcClientId ||
        !summary.hasClientSecret
      ) {
        return {
          error:
            "Save the issuer URL, client ID, and client secret before enabling SSO.",
          success: null,
        };
      }
    }

    await setSsoEnabled({
      enabled: target,
      updatedByUserId: session.user.id,
    });

    revalidatePath("/admin/authentication");
    revalidatePath("/login");
    revalidatePath("/account");
    return {
      error: null,
      success: target ? "SSO enabled." : "SSO disabled.",
    };
  } catch (err) {
    return {
      error: safeErrorMessage(err, "Failed to toggle SSO."),
      success: null,
    };
  }
}
