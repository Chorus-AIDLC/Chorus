"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { LayoutDashboard, Building2, Shield, LogOut } from "lucide-react";
import { clientLogger } from "@/lib/logger-client";

interface AdminUser {
  email: string;
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    try {
      const response = await fetch("/api/admin/session");
      const data = await response.json();

      if (data.success) {
        setUser({ email: data.data.email });
      } else {
        router.push("/login");
      }
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/admin/session", { method: "DELETE" });
      router.push("/login");
    } catch {
      clientLogger.error("Logout failed");
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">{t("common.loading")}</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const navItems = [
    {
      href: "/admin",
      label: t("admin.dashboard"),
      icon: LayoutDashboard,
    },
    {
      href: "/admin/companies",
      label: t("admin.companies"),
      icon: Building2,
    },
  ];

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="flex w-56 flex-col border-r bg-card">
        {/* Logo */}
        <div className="flex h-16 items-center gap-2 border-b px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-destructive">
            <Shield className="h-4 w-4 text-destructive-foreground" />
          </div>
          <span className="font-semibold">{t("admin.title")}</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 p-4">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/admin" && pathname.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <Button
                  variant={isActive ? "secondary" : "ghost"}
                  className="w-full justify-start"
                >
                  <Icon className="mr-3 h-5 w-5" />
                  {item.label}
                </Button>
              </Link>
            );
          })}
        </nav>

        {/* User & Logout */}
        <div className="border-t p-4">
          <div className="mb-2 truncate text-sm text-muted-foreground">
            {user.email}
          </div>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={handleLogout}
          >
            <LogOut className="mr-2 h-4 w-4" />
            {t("common.signOut")}
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
