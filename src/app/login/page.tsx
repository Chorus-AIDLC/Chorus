"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createUserManager, storeOidcConfig, type OidcConfig } from "@/lib/oidc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { clientLogger } from "@/lib/logger-client";
import type { IdentifyRoleOption } from "@/types/admin";

interface DefaultAuthInfo {
  enabled: boolean;
  superAdminCollision: boolean;
}

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [defaultAuth, setDefaultAuth] = useState<DefaultAuthInfo | null>(null);
  const [defaultAuthChecked, setDefaultAuthChecked] = useState(false);
  const [showSsoForm, setShowSsoForm] = useState(false);
  // When non-null, the role picker is shown instead of any auth form. Seeded by
  // a check-default superAdminCollision (Trigger A) or an identify multi_role
  // response (Trigger B). Each entry routes to its own existing auth flow.
  const [roleChoices, setRoleChoices] = useState<IdentifyRoleOption[] | null>(
    null
  );

  useEffect(() => {
    async function checkDefaultAuth() {
      try {
        const response = await fetch("/api/auth/check-default");
        const data = await response.json();
        if (data.success && data.data?.enabled) {
          setDefaultAuth(data.data);
          // Trigger A — the default-auth user is also the super admin. Offer
          // both up front instead of dropping into the default-auth form, so
          // the super admin can still reach /login/admin.
          if (data.data.superAdminCollision) {
            setRoleChoices([{ kind: "super_admin" }, { kind: "default_auth" }]);
          }
        }
      } catch {
        // Default auth not available, show normal flow
      } finally {
        setDefaultAuthChecked(true);
      }
    }
    checkDefaultAuth();
  }, []);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/default-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(data.error?.message || t("login.defaultAuth.error"));
        return;
      }

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
    } catch {
      setError(t("login.networkError"));
    } finally {
      setLoading(false);
    }
  };

  // Start the OIDC sign-in redirect for a single company, carrying the typed
  // email as login_hint. Shared by the single-oidc identify branch and the
  // multi_role role-picker's oidc entries so both behave identically.
  const startOidcRedirect = async (company: {
    uuid: string;
    name: string;
    oidcIssuer: string;
    oidcClientId: string;
  }) => {
    const oidcConfig: OidcConfig = {
      issuer: company.oidcIssuer,
      clientId: company.oidcClientId,
      companyUuid: company.uuid,
      companyName: company.name,
    };
    storeOidcConfig(oidcConfig);

    const userManager = createUserManager(oidcConfig);

    await userManager.signinRedirect({
      extraQueryParams: {
        login_hint: email,
      },
    });
  };

  const handleSsoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(data.error?.message || t("common.genericError"));
        return;
      }

      const result = data.data;

      if (result.type === "super_admin") {
        router.push(`/login/admin?email=${encodeURIComponent(email)}`);
      } else if (result.type === "multi_role") {
        // Trigger B — the email resolves to multiple distinct auth paths.
        // Surface the role picker; each option routes to its own flow.
        setRoleChoices(result.roles ?? []);
      } else if (result.type === "oidc_multi_match") {
        router.push(`/login/pick-workspace?email=${encodeURIComponent(email)}`);
      } else if (result.type === "oidc" && result.company) {
        await startOidcRedirect(result.company);
      } else {
        setError(result.message || t("login.noOrganizationFound"));
      }
    } catch (err) {
      clientLogger.error("Login error:", err);
      setError(t("login.networkError"));
    } finally {
      setLoading(false);
    }
  };

  // Dispatch a chosen role from the picker to its existing auth flow. Does not
  // change how any flow authenticates — only which one the user lands in.
  const handleRoleSelect = async (role: IdentifyRoleOption) => {
    setError("");
    if (role.kind === "super_admin") {
      router.push(`/login/admin?email=${encodeURIComponent(email)}`);
      return;
    }
    if (role.kind === "default_auth") {
      // Clear the picker and fall through to the default-auth password form.
      setRoleChoices(null);
      setShowSsoForm(false);
      setPassword("");
      return;
    }
    if (role.kind === "oidc" && role.company) {
      try {
        await startOidcRedirect(role.company);
      } catch (err) {
        clientLogger.error("OIDC redirect error:", err);
        setError(t("login.networkError"));
      }
    }
  };

  // Leave the role picker and return to the email / default-auth entry point.
  const handleRolePickerBack = () => {
    setRoleChoices(null);
    setError("");
    setPassword("");
    setShowSsoForm(false);
  };

  if (!defaultAuthChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">{t("common.loading")}</div>
      </div>
    );
  }

  const showRolePicker = roleChoices !== null;
  const choices = roleChoices ?? [];
  const showDefaultAuthForm =
    !showRolePicker && defaultAuth?.enabled && !showSsoForm;

  // Human-readable label for a picker option. super_admin / default_auth use
  // fixed i18n strings; oidc options are labeled by their company name.
  const roleLabel = (role: IdentifyRoleOption): string => {
    if (role.kind === "super_admin") return t("login.rolePicker.superAdmin");
    if (role.kind === "default_auth") return t("login.rolePicker.regularUser");
    return role.company
      ? t("login.rolePicker.oidcCompany", { company: role.company.name })
      : t("login.rolePicker.oidcCompanyFallback");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-[400px]">
        <CardContent className="p-10">
          {/* Logo Section */}
          <div className="mb-8 flex flex-col items-center gap-2">
            <img src="/chorus-icon.png" alt="Chorus" className="h-12 w-12" />
            <h1 className="text-[28px] font-semibold text-foreground">
              {t("login.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("login.subtitle")}
            </p>
          </div>

          {showRolePicker ? (
            <>
              {/* Role Picker — one button per resolvable auth path */}
              <p className="mb-4 text-center text-sm text-muted-foreground">
                {t("login.rolePicker.title")}
              </p>
              <div className="flex flex-col gap-3">
                {choices.map((role, index) => (
                  <Card
                    key={
                      role.kind === "oidc" && role.company
                        ? `oidc-${role.company.uuid}`
                        : `${role.kind}-${index}`
                    }
                    className="border-border py-0 shadow-none transition-colors hover:border-ring"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => handleRoleSelect(role)}
                      className="flex h-auto w-full items-center gap-3 px-4 py-3 text-left hover:bg-transparent"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {roleLabel(role)}
                      </span>
                      <ArrowRight
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </Button>
                  </Card>
                ))}
              </div>

              {error && (
                <div className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="mt-6 flex justify-center">
                <Button
                  variant="link"
                  size="sm"
                  onClick={handleRolePickerBack}
                >
                  {t("login.rolePicker.back")}
                </Button>
              </div>
            </>
          ) : showDefaultAuthForm ? (
            <>
              {/* Default Auth Password Form */}
              <form onSubmit={handlePasswordLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t("login.defaultAuth.email")}</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">{t("login.defaultAuth.password")}</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      disabled={loading}
                      autoFocus
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                    >
                      {showPassword ? (
                        <Eye className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <EyeOff className="h-5 w-5 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>

                {error && (
                  <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? t("login.checking") : t("login.defaultAuth.submit")}
                </Button>
              </form>

              {/* Divider and SSO link */}
              <div className="mt-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">{t("login.defaultAuth.orDivider")}</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className="mt-4 flex justify-center">
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setShowSsoForm(true);
                    setError("");
                    setPassword("");
                  }}
                >
                  {t("login.defaultAuth.ssoLink")}
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* Original OIDC Email Identification Form */}
              <form onSubmit={handleSsoSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t("login.email")}</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder={t("login.emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading}
                  />
                </div>

                {error && (
                  <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? t("login.checking") : t("login.continue")}
                </Button>
              </form>

              {/* Help Text */}
              <p className="mt-8 text-center text-xs text-muted-foreground">
                {t("login.helpText")}
              </p>

              {/* Back to default auth if available */}
              {defaultAuth?.enabled && (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      setShowSsoForm(false);
                      setError("");
                    }}
                  >
                    {t("login.backToLogin")}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
