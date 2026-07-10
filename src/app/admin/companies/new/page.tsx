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
import { Building2, Key, Plus, ArrowLeft } from "lucide-react";

export default function NewCompanyPage() {
  const router = useRouter();
  const t = useTranslations();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formData, setFormData] = useState({
    name: "",
    emailDomain: "",
    oidcIssuer: "",
    oidcClientId: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/admin/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          emailDomains: [formData.emailDomain.trim()],
          oidcIssuer: formData.oidcIssuer.trim(),
          oidcClientId: formData.oidcClientId.trim(),
        }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(data.error?.message || t("admin.createCompanyFailed"));
        return;
      }

      router.push(`/admin/companies/${data.data.uuid}`);
    } catch {
      setError(t("admin.networkError"));
    } finally {
      setLoading(false);
    }
  };

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
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

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

            <div className="space-y-2">
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
            </div>
          </CardContent>
        </Card>

        {/* OIDC Configuration Card */}
        <Card>
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
        </Card>

        {/* Action Bar */}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={
              loading ||
              !formData.name ||
              !formData.emailDomain ||
              !formData.oidcIssuer ||
              !formData.oidcClientId
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
