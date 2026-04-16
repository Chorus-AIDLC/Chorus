"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createUserManager,
  getStoredOidcConfig,
  extractUserInfo,
} from "@/lib/oidc";
import { initUserManager } from "@/lib/auth-client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Music, Loader2 } from "lucide-react";
import { clientLogger } from "@/lib/logger-client";

export default function OidcCallbackPage() {
  const router = useRouter();
  const t = useTranslations("login");
  const [error, setError] = useState("");
  const [statusKey, setStatusKey] = useState("processingLogin");

  // Guard against React Strict Mode double execution
  // Authorization codes are one-time use, so we must prevent double callback processing
  const callbackProcessed = useRef(false);

  useEffect(() => {
    // Prevent double execution in React Strict Mode (development)
    if (callbackProcessed.current) {
      return;
    }
    callbackProcessed.current = true;

    handleCallback();
  }, []);

  const handleCallback = async () => {
    try {
      // Get stored OIDC config
      const oidcConfig = getStoredOidcConfig();
      if (!oidcConfig) {
        setError(t("sessionExpired"));
        setTimeout(() => router.push("/login"), 2000);
        return;
      }

      setStatusKey("completingAuth");

      // Create UserManager with same config
      const userManager = createUserManager(oidcConfig);

      // Complete the signin process
      const user = await userManager.signinRedirectCallback();

      if (!user) {
        throw new Error("No user returned from OIDC provider");
      }

      setStatusKey("registeringUser");

      // Extract user info from OIDC response
      const userInfo = extractUserInfo(user);

      // Register user in backend and store access token in HTTP-only cookie
      const response = await fetch("/api/auth/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyUuid: oidcConfig.companyUuid,
          oidcSub: userInfo.sub,
          email: userInfo.email,
          name: userInfo.name,
          accessToken: user.access_token, // Send token to be stored in HTTP-only cookie
          refreshToken: user.refresh_token, // Send refresh token for server-side refresh
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error?.message || "Failed to register user");
      }

      // Initialize UserManager singleton for future use
      // The OIDC tokens are already stored by oidc-client-ts in localStorage
      // The config is also stored in localStorage for recreating UserManager after page navigation
      initUserManager(oidcConfig);

      setStatusKey("loginSuccess");

      // Check if user needs onboarding
      const onboardingCompleted = localStorage.getItem("chorus_onboarding_completed");
      if (onboardingCompleted) {
        router.push("/projects");
        return;
      }

      // Check if user has any agents
      try {
        const agentsRes = await fetch("/api/agents");
        const agentsData = await agentsRes.json();
        if (agentsData.success && agentsData.data.length === 0) {
          router.push("/onboarding");
          return;
        }
      } catch {
        // If agents check fails, proceed to projects
      }
      router.push("/projects");
    } catch (err) {
      clientLogger.error("OIDC callback error:", err);
      setError(
        err instanceof Error ? err.message : t("authFailed")
      );
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-[400px]">
        <CardContent className="p-10">
          {/* Logo */}
          <div className="mb-8 flex flex-col items-center gap-2">
            <Music className="h-12 w-12 text-foreground" />
            <h1 className="text-[28px] font-semibold text-foreground">{t("title")}</h1>
          </div>

          {/* Status */}
          {error ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-destructive/10 p-4 text-center text-sm text-destructive">
                {error}
              </div>
              <Button onClick={() => router.push("/login")} className="w-full">
                {t("backToLogin")}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-foreground" />
                <span className="text-sm text-muted-foreground">{t(statusKey)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
