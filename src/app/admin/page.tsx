"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Users, Bot, Plus } from "lucide-react";
import { clientLogger } from "@/lib/logger-client";

interface Stats {
  totalCompanies: number;
  totalUsers: number;
  totalAgents: number;
}

export default function AdminDashboardPage() {
  const t = useTranslations();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const response = await fetch("/api/admin/companies?pageSize=1");
      const data = await response.json();

      if (data.success) {
        setStats({
          totalCompanies: data.meta?.total || 0,
          totalUsers: 0,
          totalAgents: 0,
        });
      }
    } catch (error) {
      clientLogger.error("Failed to fetch stats:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full bg-background px-8 py-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-foreground">{t("admin.dashboard")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin.welcome")}
        </p>
      </div>

      {/* Stats Cards */}
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("admin.totalCompanies")}
              </CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">
              {loading ? "..." : stats?.totalCompanies || 0}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("admin.registeredOrgs")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("admin.totalUsers")}
              </CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">
              {loading ? "..." : stats?.totalUsers || 0}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("admin.humanUsers")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t("admin.totalAgents")}
              </CardTitle>
              <Bot className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">
              {loading ? "..." : stats?.totalAgents || 0}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("admin.aiAgents")}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>{t("admin.quickActions")}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("admin.commonTasks")}
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <Link href="/admin/companies/new">
              <Button
                variant="outline"
                className="h-auto w-full justify-start gap-4 p-4"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
                  <Plus className="h-5 w-5" />
                </div>
                <div className="text-left">
                  <div className="font-medium">{t("admin.addCompany")}</div>
                  <div className="text-sm text-muted-foreground">
                    {t("admin.addCompanyDesc")}
                  </div>
                </div>
              </Button>
            </Link>

            <Link href="/admin/companies">
              <Button
                variant="outline"
                className="h-auto w-full justify-start gap-4 p-4"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
                  <Building2 className="h-5 w-5" />
                </div>
                <div className="text-left">
                  <div className="font-medium">{t("admin.manageCompanies")}</div>
                  <div className="text-sm text-muted-foreground">
                    {t("admin.manageCompaniesDesc")}
                  </div>
                </div>
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
