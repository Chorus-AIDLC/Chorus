"use client";

import { useState, useEffect } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import { createUserManager, storeOidcConfig, type OidcConfig } from "@/lib/oidc";
import { authFetch, resyncRefreshTokenFromStore } from "@/lib/auth-client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { clientLogger } from "@/lib/logger-client";
import type { IdentifyRoleOption } from "@/types/admin";
import { isImeComposing } from "@/lib/ime";

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [defaultPasswordSelected, setDefaultPasswordSelected] = useState(false);
  // Until we've confirmed the visitor is NOT already logged in, hold the form back so an
  // already-authenticated user (e.g. bounced here after an iOS reopen) is redirected into
  // the app instead of being stranded on the login form. See the auth-check effect below.
  const [authChecked, setAuthChecked] = useState(false);
  const [localCompany, setLocalCompany] = useState<{ uuid: string; name: string } | null>(null);
  // Only identify results can select an auth path or show the workspace/role
  // picker. Deployment defaults must not bypass identifier discovery.
  const [roleChoices, setRoleChoices] = useState<IdentifyRoleOption[] | null>(
    null
  );

  // If the visitor is ALREADY logged in, send them into the app instead of showing the
  // login form. This is the other half of the iOS-reopen fix: when a still-valid session
  // gets bounced to /login (e.g. a root-route probe that 401'd before the cookie was
  // refreshed), /login previously had no auth check and stranded the user on the form.
  // We prime the cookie (matcher-covered request → middleware refreshes from the refresh
  // token) and then probe; an admin session goes to /admin, a user session to /projects.
  // A 401 / transient failure just falls through to render the form (the normal path).
  useEffect(() => {
    let cancelled = false;
    async function redirectIfAuthenticated() {
      try {
        // Admin session first (mirrors the root route's precedence).
        const adminRes = await fetch("/api/admin/session");
        const adminData = await adminRes.json().catch(() => ({}));
        if (!cancelled && adminData?.success) {
          router.replace("/admin");
          return;
        }

        let res = await authFetch("/api/session");
        if (res.status === 401) {
          res = await authFetch("/api/session");
        }
        if (res.status === 401) {
          // Last resort (idea 3bf0819c): a user bounced here by an iOS cookie purge
          // still has a live refresh token in localStorage. Rebuild the refresh
          // materials and re-probe — a recovered session is sent straight back to
          // /projects below instead of being shown the login form.
          if (await resyncRefreshTokenFromStore()) {
            res = await authFetch("/api/session");
          }
        }
        if (!cancelled && res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data?.success && data?.data?.user) {
            router.replace("/projects");
            return;
          }
        }
      } catch {
        // Not authenticated / transient — fall through and show the login form.
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    }
    redirectIfAuthenticated();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(localCompany ? "/api/auth/local/login" : "/api/auth/default-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localCompany
          ? { companyUuid: localCompany.uuid, identifier: email, password }
          : { email, password }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(localCompany
          ? t(response.status === 429 ? "login.local.rateLimited" : "login.local.invalidCredentials")
          : data.error?.message || t("login.defaultAuth.error"));
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

  const handleIdentifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(email.includes("@") ? { email } : { identifier: email }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(t(response.status === 429 ? "login.local.rateLimited" : "login.noOrganizationFound"));
        return;
      }

      const result = data.data;

      if (result.type === "local" && result.company) {
        setLocalCompany(result.company);
        setPassword("");
        setRoleChoices(null);
      } else if (result.type === "default_auth") {
        setDefaultPasswordSelected(true);
        setRoleChoices(null);
      } else if (result.type === "super_admin") {
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
        setError(t("login.noOrganizationFound"));
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
    if (role.kind === "local") {
      setLocalCompany(role.company);
      setRoleChoices(null);
      setPassword("");
      return;
    }
    if (role.kind === "super_admin") {
      router.push(`/login/admin?email=${encodeURIComponent(email)}`);
      return;
    }
    if (role.kind === "default_auth") {
      // Clear the picker and fall through to the default-auth password form.
      setRoleChoices(null);
      setDefaultPasswordSelected(true);
      setPassword("");
      return;
    }
    if (role.kind === "oidc" && role.company) {
      setLoading(true);
      try {
        await startOidcRedirect(role.company);
      } catch (err) {
        clientLogger.error("OIDC redirect error:", err);
        setError(t("login.networkError"));
      } finally {
        setLoading(false);
      }
    }
  };

  // Returning always restores identifier discovery, never a deployment default.
  const handleRolePickerBack = () => {
    setLocalCompany(null);
    setRoleChoices(null);
    setError("");
    setPassword("");
    setShowPassword(false);
    setDefaultPasswordSelected(false);
  };

  // Hold the form until the already-authenticated probe resolves.
  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">{t("common.loading")}</div>
      </div>
    );
  }

  const showRolePicker = roleChoices !== null;
  const choices = roleChoices ?? [];
  const showDefaultAuthForm = !showRolePicker && defaultPasswordSelected;

  // Human-readable label for a picker option. super_admin / default_auth use
  // fixed i18n strings; oidc options are labeled by their company name.
  const roleLabel = (role: IdentifyRoleOption): string => {
    if (role.kind === "super_admin") return t("login.rolePicker.superAdmin");
    if (role.kind === "default_auth") return t("login.rolePicker.regularUser");
    if (role.kind === "local") return t("login.local.workspace", { company: role.company.name });
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

          {localCompany ? (
            <form onSubmit={handlePasswordLogin} onKeyDown={(e) => {
              if (e.key === "Enter" && isImeComposing(e)) e.preventDefault();
            }} className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("login.local.workspace", { company: localCompany.name })}</p>
              <div className="space-y-2">
                <Label htmlFor="local-identifier">{t("login.email")}</Label>
                <Input id="local-identifier" value={email} readOnly autoComplete="username" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="local-password">{t("login.defaultAuth.password")}</Label>
                <Input id="local-password" type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
                  required disabled={loading} autoFocus />
              </div>
              {error && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
              <Button type="submit" disabled={loading} className="w-full">{loading ? t("login.checking") : t("login.defaultAuth.submit")}</Button>
              <Button type="button" variant="link" disabled={loading} onClick={handleRolePickerBack}>{t("login.rolePicker.back")}</Button>
            </form>
          ) : showRolePicker ? (
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
                      disabled={loading}
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
                  <Label htmlFor="email">{t("login.email")}</Label>
                  <Input id="email" value={email} readOnly autoComplete="username" />
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

              <div className="mt-4 flex justify-center">
                <Button type="button" variant="link" size="sm" disabled={loading} onClick={handleRolePickerBack}>
                  {t("login.rolePicker.back")}
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* Shared username/email discovery for every login method */}
              <form onSubmit={handleIdentifySubmit} onKeyDown={(e) => {
                if (e.key === "Enter" && isImeComposing(e)) e.preventDefault();
              }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t("login.email")}</Label>
                  <Input
                    id="email"
                    type="text"
                    autoComplete="username"
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

            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
