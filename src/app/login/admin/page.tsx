"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Shield, Eye, EyeOff, ArrowLeft } from "lucide-react";

function AdminLoginForm() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Whether the email arrived via the `?email=` query param. When it did, we
  // display it read-only (it was already chosen on the previous screen). When
  // it did not — e.g. the login page's up-front collision picker, which never
  // learns the email because /api/auth/check-default deliberately does not echo
  // it — we must let the super admin type it here, or this page is a dead end.
  const [emailFromParam, setEmailFromParam] = useState(false);

  useEffect(() => {
    const emailParam = searchParams.get("email");
    if (emailParam) {
      setEmail(emailParam);
      setEmailFromParam(true);
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(data.error?.message || t("admin.invalidCredentials"));
        return;
      }

      router.push(data.data.redirectTo || "/admin");
    } catch {
      setError(t("login.networkError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-[400px]">
        <CardContent className="p-10">
          {/* Logo Section */}
          <div className="mb-8 flex flex-col items-center gap-2">
            <Shield className="h-12 w-12 text-destructive" />
            <h1 className="text-[28px] font-semibold text-foreground">
              {t("admin.title")}
            </h1>
            {emailFromParam && (
              <p className="text-sm text-muted-foreground">{email}</p>
            )}
          </div>

          {/* Form Section */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {!emailFromParam && (
              <div className="space-y-2">
                <Label htmlFor="email">{t("admin.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder={t("admin.emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading}
                  autoFocus
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="password">{t("admin.password")}</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t("admin.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  autoFocus={emailFromParam}
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

            <Button
              type="submit"
              disabled={loading}
              variant="destructive"
              className="w-full"
            >
              {loading ? t("admin.signingIn") : t("admin.signInAsAdmin")}
            </Button>
          </form>

          {/* Back Link */}
          <div className="mt-8 flex justify-center">
            <Link href="/login">
              <Button variant="ghost" size="sm" className="gap-1">
                <ArrowLeft className="h-4 w-4" />
                {t("admin.backToEmail")}
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminLoginPage() {
  const t = useTranslations();
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="text-muted-foreground">{t("common.loading")}</div>
        </div>
      }
    >
      <AdminLoginForm />
    </Suspense>
  );
}
