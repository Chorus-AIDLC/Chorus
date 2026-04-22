"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Building2,
  Users,
  Bot,
  FolderKanban,
  ArrowLeft,
  Trash2,
  Key,
} from "lucide-react";
import { formatDateTime } from "@/lib/format-date";

interface CompanyDetail {
  uuid: string;
  name: string;
  emailDomains: string[];
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcEnabled: boolean;
  userCount: number;
  agentCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export default function CompanyDetailPage({
  params,
}: {
  params: Promise<{ uuid: string }>;
}) {
  const t = useTranslations();
  const { uuid } = use(params);
  const router = useRouter();
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Form state
  const [name, setName] = useState("");
  const [emailDomains, setEmailDomains] = useState("");
  const [oidcIssuer, setOidcIssuer] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");

  useEffect(() => {
    fetchCompany();
  }, [uuid]);

  const fetchCompany = async () => {
    try {
      const response = await fetch(`/api/admin/companies/${uuid}`);
      const data = await response.json();

      if (data.success) {
        const c = data.data;
        setCompany(c);
        setName(c.name);
        setEmailDomains(c.emailDomains.join(", "));
        setOidcIssuer(c.oidcIssuer || "");
        setOidcClientId(c.oidcClientId || "");
      } else {
        setError(data.error?.message || t("admin.companyNotFound"));
      }
    } catch {
      setError(t("admin.failedToLoad"));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);

    try {
      // Parse email domains
      const domains = emailDomains
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);

      // OIDC is enabled if both issuer and clientId are provided
      const oidcEnabled = !!(oidcIssuer.trim() && oidcClientId.trim());

      const response = await fetch(`/api/admin/companies/${uuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          emailDomains: domains,
          oidcIssuer: oidcIssuer.trim() || null,
          oidcClientId: oidcClientId.trim() || null,
          oidcEnabled,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(data.error?.message || t("admin.failedToUpdate"));
        return;
      }

      setSuccess(t("admin.companyUpdated"));
      fetchCompany();
    } catch {
      setError(t("admin.networkError"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (
      !confirm(
        t("admin.deleteCompanyConfirmFull", { name: company?.name || "" })
      )
    ) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/companies/${uuid}`, {
        method: "DELETE",
      });

      if (response.ok) {
        router.push("/admin/companies");
      } else {
        const data = await response.json();
        setError(data.error?.message || t("admin.failedToDelete"));
      }
    } catch {
      setError(t("admin.networkError"));
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-background">
        <div className="text-muted-foreground">{t("common.loading")}</div>
      </div>
    );
  }

  if (!company) {
    return (
      <div className="min-h-full bg-background px-8 py-6">
        <div className="mb-6">
          <Link href="/admin/companies">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("admin.backToCompanies")}
            </Button>
          </Link>
        </div>
        <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
          {error || t("admin.companyNotFound")}
        </div>
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

      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {company.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("admin.createdOn", { date: formatDateTime(company.createdAt) })}
          </p>
        </div>
        <Button variant="destructive" onClick={handleDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t("admin.deleteCompany")}
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("admin.tableUsers")}
              </CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{company.userCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("admin.tableAgents")}
              </CardTitle>
              <Bot className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{company.agentCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("admin.projects")}
              </CardTitle>
              <FolderKanban className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{company.projectCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Information */}
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
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={saving}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="emailDomains">{t("admin.emailDomains")}</Label>
              <Input
                id="emailDomains"
                value={emailDomains}
                onChange={(e) => setEmailDomains(e.target.value)}
                placeholder={t("admin.emailDomainsPlaceholder")}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                {t("admin.emailDomainsHelp")}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* OIDC Configuration */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4" />
                <CardTitle className="text-sm font-medium">
                  {t("admin.oidcConfig")}
                </CardTitle>
              </div>
              {company.oidcEnabled ? (
                <Badge variant="success">{t("admin.oidcEnabled")}</Badge>
              ) : (
                <Badge variant="warning">{t("admin.oidcNotConfigured")}</Badge>
              )}
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
                value={oidcIssuer}
                onChange={(e) => setOidcIssuer(e.target.value)}
                placeholder={t("admin.oidcIssuerUrlPlaceholder")}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                {t("admin.oidcIssuerUrlHelp")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="oidcClientId">{t("admin.clientId")}</Label>
              <Input
                id="oidcClientId"
                value={oidcClientId}
                onChange={(e) => setOidcClientId(e.target.value)}
                placeholder={t("admin.clientIdPlaceholder")}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                {t("admin.clientIdHelp")}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Messages */}
        {error && (
          <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg bg-green-50 p-3 text-sm text-green-600">
            {success}
          </div>
        )}

        {/* Action Bar */}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? t("common.saving") : t("admin.saveChanges")}
          </Button>
          <Link href="/admin/companies">
            <Button type="button" variant="outline" disabled={saving}>
              {t("common.cancel")}
            </Button>
          </Link>
        </div>
      </form>
    </div>
  );
}
