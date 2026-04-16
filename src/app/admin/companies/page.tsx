"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CompanyListItem } from "@/types/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Pencil, Trash2, Info, Copy, Check } from "lucide-react";
import { clientLogger } from "@/lib/logger-client";

export default function CompaniesPage() {
  const t = useTranslations();
  const [companies, setCompanies] = useState<CompanyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [copied, setCopied] = useState(false);

  // Get callback URL based on current origin
  const getCallbackUrl = () => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/login/callback`;
  };

  useEffect(() => {
    fetchCompanies();
  }, []);

  const fetchCompanies = async () => {
    try {
      const response = await fetch("/api/admin/companies?pageSize=50");
      const data = await response.json();

      if (data.success) {
        setCompanies(data.data);
        setTotal(data.meta?.total || 0);
      }
    } catch (error) {
      clientLogger.error("Failed to fetch companies:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (uuid: string, name: string) => {
    if (
      !confirm(
        t("admin.deleteCompanyConfirm", { name })
      )
    ) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/companies/${uuid}`, {
        method: "DELETE",
      });

      if (response.ok) {
        fetchCompanies();
      } else {
        const data = await response.json();
        alert(data.error?.message || t("admin.failedToDelete"));
      }
    } catch {
      alert(t("admin.networkError"));
    }
  };

  const handleCopyCallback = async () => {
    const url = getCallbackUrl();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = url;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-full bg-background px-8 py-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("admin.companies")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("admin.registeredOrgsCount", { count: total })}
          </p>
        </div>
        <Link href="/admin/companies/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            {t("admin.addCompany")}
          </Button>
        </Link>
      </div>

      {/* OIDC Callback URL Info */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50">
              <Info className="h-4 w-4 text-blue-600" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-sm font-medium">
                {t("admin.oidcRedirectUri")}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("admin.oidcRedirectUriDesc")}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded-lg border bg-secondary px-3 py-2 text-xs">
                  {typeof window !== "undefined"
                    ? getCallbackUrl()
                    : "/login/callback"}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyCallback}
                >
                  {copied ? (
                    <>
                      <Check className="mr-1.5 h-3.5 w-3.5 text-green-600" />
                      {t("common.copied")}
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      {t("common.copy")}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin.tableName")}</TableHead>
              <TableHead>{t("admin.tableEmailDomains")}</TableHead>
              <TableHead>{t("admin.tableOidcStatus")}</TableHead>
              <TableHead className="text-right">{t("admin.tableUsers")}</TableHead>
              <TableHead className="text-right">{t("admin.tableAgents")}</TableHead>
              <TableHead className="text-right">{t("admin.tableActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center">
                  <span className="text-muted-foreground">{t("common.loading")}</span>
                </TableCell>
              </TableRow>
            ) : companies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center">
                  <span className="text-muted-foreground">
                    {t("admin.noCompanies")}{" "}
                    <Link
                      href="/admin/companies/new"
                      className="text-foreground underline hover:no-underline"
                    >
                      {t("admin.addFirstCompany")}
                    </Link>
                  </span>
                </TableCell>
              </TableRow>
            ) : (
              companies.map((company) => (
                <TableRow key={company.uuid}>
                  <TableCell className="font-medium">{company.name}</TableCell>
                  <TableCell>
                    {company.emailDomains.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {company.emailDomains.map((domain) => (
                          <Badge key={domain} variant="secondary">
                            {domain}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {company.oidcEnabled ? (
                      <Badge variant="success">{t("admin.oidcConfigured")}</Badge>
                    ) : (
                      <Badge variant="warning">{t("admin.oidcNotConfigured")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {company.userCount}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {company.agentCount}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Link href={`/admin/companies/${company.uuid}`}>
                        <Button variant="ghost" size="icon">
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDelete(company.uuid, company.name)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
