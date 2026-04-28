"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  createUserManager,
  storeOidcConfig,
  type OidcConfig,
} from "@/lib/oidc";
import { clientLogger } from "@/lib/logger-client";
import { getProjectIconColor, getProjectInitials } from "@/lib/project-colors";
import type { IdentifyCandidate, IdentifyResponse } from "@/types/admin";

type PickerState =
  | { status: "loading" }
  | { status: "ready"; candidates: IdentifyCandidate[] }
  | { status: "empty"; message: string }
  | { status: "error" };

export default function PickWorkspacePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations();

  const rawEmail = searchParams.get("email");
  let email = "";
  try {
    email = rawEmail ? decodeURIComponent(rawEmail) : "";
  } catch {
    email = "";
  }

  const [state, setState] = useState<PickerState>({ status: "loading" });
  const [pendingUuid, setPendingUuid] = useState<string | null>(null);

  useEffect(() => {
    if (!email) {
      router.replace("/login");
      return;
    }

    let cancelled = false;

    async function identify() {
      try {
        const response = await fetch("/api/auth/identify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const payload = await response.json();

        if (cancelled) return;

        if (!payload.success) {
          setState({ status: "error" });
          return;
        }

        const result = payload.data as IdentifyResponse;

        if (result.type === "oidc_multi_match") {
          const candidates = result.candidates ?? [];
          if (candidates.length === 0) {
            setState({
              status: "empty",
              message: t("login.pickWorkspace.noCandidates"),
            });
            return;
          }
          setState({ status: "ready", candidates });
          return;
        }

        if (result.type === "oidc" && result.company) {
          const oidcConfig: OidcConfig = {
            issuer: result.company.oidcIssuer,
            clientId: result.company.oidcClientId,
            companyUuid: result.company.uuid,
            companyName: result.company.name,
          };
          storeOidcConfig(oidcConfig);
          const userManager = createUserManager(oidcConfig);
          await userManager.signinRedirect({
            extraQueryParams: { login_hint: email },
          });
          return;
        }

        if (result.type === "not_found") {
          setState({
            status: "empty",
            message: result.message ?? t("login.pickWorkspace.noCandidates"),
          });
          return;
        }

        router.replace("/login");
      } catch (err) {
        clientLogger.error("pick-workspace identify error:", err);
        if (!cancelled) {
          setState({ status: "error" });
        }
      }
    }

    identify();

    return () => {
      cancelled = true;
    };
  }, [email, router, t]);

  const handleSelect = useCallback(
    async (candidate: IdentifyCandidate) => {
      setPendingUuid(candidate.uuid);
      try {
        const response = await fetch(
          `/api/auth/company-oidc?uuid=${encodeURIComponent(
            candidate.uuid
          )}&email=${encodeURIComponent(email)}`
        );
        const payload = await response.json();
        if (!payload.success || !payload.data) {
          setState({ status: "error" });
          setPendingUuid(null);
          return;
        }

        const oidcConfig: OidcConfig = {
          issuer: payload.data.oidcIssuer,
          clientId: payload.data.oidcClientId,
          companyUuid: payload.data.uuid,
          companyName: payload.data.name,
        };
        storeOidcConfig(oidcConfig);
        const userManager = createUserManager(oidcConfig);
        await userManager.signinRedirect({
          extraQueryParams: { login_hint: email },
        });
      } catch (err) {
        clientLogger.error("pick-workspace select error:", err);
        setState({ status: "error" });
        setPendingUuid(null);
      }
    },
    [email]
  );

  const goToLogin = () => router.push("/login");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-[440px]">
        <CardContent className="p-10">
          <div className="mb-6 flex flex-col items-center gap-2">
            <img src="/chorus-icon.png" alt="Chorus" className="h-12 w-12" />
            <h1 className="text-[22px] font-semibold text-foreground">
              {t("login.pickWorkspace.title")}
            </h1>
            {state.status === "ready" && (
              <p className="text-center text-sm text-muted-foreground">
                {t("login.pickWorkspace.subtitle", {
                  count: state.candidates.length,
                })}
              </p>
            )}
          </div>

          {state.status === "loading" && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("login.pickWorkspace.loading")}
            </p>
          )}

          {state.status === "error" && (
            <p className="py-6 text-center text-sm text-destructive">
              {t("login.pickWorkspace.errorLoading")}
            </p>
          )}

          {state.status === "empty" && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {state.message}
            </p>
          )}

          {state.status === "ready" && (
            <div className="flex flex-col gap-3">
              {state.candidates.map((candidate) => {
                const isPending = pendingUuid === candidate.uuid;
                const iconColor = getProjectIconColor(candidate.name);
                return (
                  <Card
                    key={candidate.uuid}
                    className="border-border py-0 shadow-none transition-colors hover:border-ring"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => handleSelect(candidate)}
                      disabled={pendingUuid !== null}
                      aria-busy={isPending}
                      className="flex h-auto w-full items-center gap-3 px-4 py-3 text-left hover:bg-transparent"
                    >
                      <span
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-sm font-semibold"
                        style={{ backgroundColor: iconColor.bg, color: iconColor.text }}
                        aria-hidden="true"
                      >
                        {getProjectInitials(candidate.name)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-foreground">
                          {candidate.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {candidate.oidcIssuerHost}
                        </span>
                      </span>
                      <ArrowRight
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </Button>
                  </Card>
                );
              })}
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-muted-foreground">
            {email && (
              <span className="truncate" title={email}>
                {email}
              </span>
            )}
            <Button
              variant="link"
              size="sm"
              onClick={goToLogin}
              className="h-auto p-0 text-xs"
            >
              {t("login.pickWorkspace.differentEmail")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
