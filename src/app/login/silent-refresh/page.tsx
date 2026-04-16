"use client";

import { useEffect } from "react";
import { UserManager } from "oidc-client-ts";
import { getStoredOidcConfig, createUserManager } from "@/lib/oidc";
import { clientLogger } from "@/lib/logger-client";

// Silent refresh page for OIDC token renewal
// This page is loaded in a hidden iframe by oidc-client-ts
export default function SilentRefreshPage() {
  useEffect(() => {
    // Try to use stored OIDC config for full UserManager configuration
    const config = getStoredOidcConfig();
    const userManager = config
      ? createUserManager(config)
      : new UserManager({
          authority: "",
          client_id: "",
          redirect_uri: "",
        });

    // Process the silent renew callback
    userManager.signinSilentCallback().catch((err) => {
      clientLogger.error("Silent refresh callback error:", err);
    });
  }, []);

  // Return empty - this page runs in a hidden iframe
  return null;
}
