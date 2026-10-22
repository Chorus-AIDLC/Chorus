"use client";

import { useState } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { isImeComposing } from "@/lib/ime";
import { credentialLinkUrl } from "@/lib/credential-link";
import type { CredentialLink } from "@/types/local-user";
import { Building2, Key, Plus, ArrowLeft, Copy } from "lucide-react";

export default function NewCompanyPage() {
  const router = useRouter();
  const t = useTranslations();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"oidc" | "local">("oidc");
  const [initialAdmin, setInitialAdmin] = useState({ username: "", email: "", name: "" });
  const [bootstrap, setBootstrap] = useState<{
    company: { uuid: string; name: string };
    credentialLink: CredentialLink;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    emailDomain: "",
    oidcIssuer: "",
    oidcClientId: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || bootstrap) return;
    setError("");
    setLoading(true);

    try {
      const response = await fetch(mode === "local" ? "/api/admin/companies/local" : "/api/admin/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "local" ? {
          name: formData.name.trim(),
          initialAdmin: {
            username: initialAdmin.username.trim(),
            email: initialAdmin.email.trim(),
            ...(initialAdmin.name.trim() ? { name: initialAdmin.name.trim() } : {}),
          },
        } : {
          name: formData.name.trim(),
          emailDomains: [formData.emailDomain.trim()],
          oidcIssuer: formData.oidcIssuer.trim(),
          oidcClientId: formData.oidcClientId.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setError((typeof data.error === "string" ? data.error : data.error?.message) || t("admin.createCompanyFailed"));
        return;
      }

      if (mode === "local") {
        setBootstrap({ ...data.data, credentialLink: { ...data.data.credentialLink, url: credentialLinkUrl(data.data.credentialLink.url, window.location.origin) } });
      } else {
        router.push(`/admin/companies/${data.data.uuid}`);
      }
    } catch {
      setError(t("admin.networkError"));
    } finally {
      setLoading(false);
    }
  };

  const copyLink = async () => {
    if (!bootstrap?.credentialLink.url) return;
    setError("");
    try {
      await navigator.clipboard.writeText(bootstrap.credentialLink.url);
      setCopied(true);
    } catch {
      setCopied(false);
      setError(t("admin.localBootstrap.copyFailed"));
    }
  };

  if (bootstrap) {
    return (
      <div className="min-h-full bg-background px-8 py-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("admin.localBootstrap.created", { name: bootstrap.company.name })}</CardTitle>
            <CardDescription>{t("admin.localBootstrap.shareHelp")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="space-y-2">
              <Label htmlFor="credentialLink">{t("admin.localBootstrap.invitationLink")}</Label>
              <Input id="credentialLink" readOnly value={bootstrap.credentialLink.url} onFocus={(e) => e.target.select()} />
            </div>
            <p className="text-sm text-muted-foreground">
              {t("admin.localBootstrap.expiresAt", { expiresAt: bootstrap.credentialLink.expiresAt })}
            </p>
            <Button type="button" variant="outline" disabled={!bootstrap.credentialLink.url} onClick={copyLink}>
              <Copy className="mr-2 h-4 w-4" />
              {t("admin.localBootstrap.copyLink")}
            </Button>
            {copied && <p role="status" className="text-sm text-muted-foreground">{t("admin.localBootstrap.copied")}</p>}
            <div>
              <Button type="button" onClick={() => router.push(`/admin/companies/${bootstrap.company.uuid}`)}>
                {t("admin.localBootstrap.continue")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background px-8 py-6">
      {/* Back Link */}
      <div className="mb-6">
        <Link href="/admin/companies">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("admin.backToCompanies")}
          </Button>
        </Link>
      </div>

      {/* Title Section */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">
          {t("admin.createCompany")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin.createCompanyDesc")}
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} onKeyDown={(e) => {
        if (e.key === "Enter" && isImeComposing(e)) {
          e.preventDefault();
          return;
        }
      }} className="space-y-6">
        {error && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium" id="authModeLabel">{t("admin.localBootstrap.authMode")}</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup aria-labelledby="authModeLabel" value={mode} disabled={loading} onValueChange={(value) => {
              setMode(value as "oidc" | "local");
              setError("");
            }} className="space-y-3">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="oidc" id="modeOidc" />
                <Label htmlFor="modeOidc">{t("admin.localBootstrap.oidcMode")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="local" id="modeLocal" />
                <Label htmlFor="modeLocal">{t("admin.localBootstrap.localMode")}</Label>
              </div>
            </RadioGroup>
            <p className="mt-3 text-sm text-muted-foreground">{t(`admin.localBootstrap.${mode}Help`)}</p>
          </CardContent>
        </Card>

        {/* Basic Information Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              <CardTitle className="text-sm font-medium">
                {t("admin.basicInfo")}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t("admin.companyName")}</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                placeholder={t("admin.companyNamePlaceholder")}
                required
                disabled={loading}
              />
            </div>

            {mode === "oidc" && <div className="space-y-2">
              <Label htmlFor="emailDomain">{t("admin.emailDomain")}</Label>
              <Input
                id="emailDomain"
                value={formData.emailDomain}
                onChange={(e) =>
                  setFormData({ ...formData, emailDomain: e.target.value })
                }
                placeholder={t("admin.emailDomainPlaceholder")}
                required
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground">
                {t("admin.emailDomainHelp")}
              </p>
            </div>}
          </CardContent>
        </Card>

        {mode === "local" && <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("admin.localBootstrap.initialAdmin")}</CardTitle>
            <CardDescription>{t("admin.localBootstrap.initialAdminHelp")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="adminUsername">{t("admin.localBootstrap.username")}</Label>
              <Input id="adminUsername" value={initialAdmin.username} onChange={(e) => setInitialAdmin({ ...initialAdmin, username: e.target.value })} required pattern="[^@]+" disabled={loading} autoComplete="off" aria-describedby="usernameHelp" />
              <p id="usernameHelp" className="text-xs text-muted-foreground">{t("admin.localBootstrap.usernameHelp")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="adminEmail">{t("admin.localBootstrap.email")}</Label>
              <Input id="adminEmail" type="email" value={initialAdmin.email} onChange={(e) => setInitialAdmin({ ...initialAdmin, email: e.target.value })} required disabled={loading} autoComplete="off" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adminName">{t("admin.localBootstrap.name")}</Label>
              <Input id="adminName" value={initialAdmin.name} onChange={(e) => setInitialAdmin({ ...initialAdmin, name: e.target.value })} maxLength={200} disabled={loading} autoComplete="off" />
              <p className="text-xs text-muted-foreground">{t("workspaceUsers.nameHint")}</p>
            </div>
          </CardContent>
        </Card>}

        {/* OIDC Configuration Card */}
        {mode === "oidc" && <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4" />
                <CardTitle className="text-sm font-medium">
                  {t("admin.oidcConfig")}
                </CardTitle>
              </div>
              <Badge variant="destructive" className="text-[11px]">
                {t("admin.required")}
              </Badge>
            </div>
            <CardDescription>
              {t("admin.oidcConfigDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="oidcIssuer">{t("admin.oidcIssuerUrl")}</Label>
              <Input
                id="oidcIssuer"
                type="url"
                value={formData.oidcIssuer}
                onChange={(e) =>
                  setFormData({ ...formData, oidcIssuer: e.target.value })
                }
                placeholder={t("admin.oidcIssuerUrlPlaceholder")}
                required
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground">
                {t("admin.oidcIssuerUrlHelp")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="oidcClientId">{t("admin.clientId")}</Label>
              <Input
                id="oidcClientId"
                value={formData.oidcClientId}
                onChange={(e) =>
                  setFormData({ ...formData, oidcClientId: e.target.value })
                }
                placeholder={t("admin.clientIdPlaceholder")}
                required
                disabled={loading}
              />
            </div>
          </CardContent>
        </Card>}

        {/* Action Bar */}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={
              loading ||
              !formData.name.trim() ||
              (mode === "local"
                ? !initialAdmin.username.trim() || initialAdmin.username.includes("@") || !initialAdmin.email.trim()
                : !formData.emailDomain.trim() || !formData.oidcIssuer.trim() || !formData.oidcClientId.trim())
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            {loading ? t("common.creating") : t("admin.createCompany")}
          </Button>
          <Link href="/admin/companies">
            <Button type="button" variant="outline" disabled={loading}>
              {t("common.cancel")}
            </Button>
          </Link>
        </div>
      </form>
    </div>
  );
}
