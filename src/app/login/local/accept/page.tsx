"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/hooks/use-progress-router";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isImeComposing } from "@/lib/ime";

export default function AcceptCredentialPage() {
  const t = useTranslations("login.local");
  const router = useRouter();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const tokenCaptured = useRef(false);

  useEffect(() => {
    if (tokenCaptured.current) return;
    tokenCaptured.current = true;
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
    // Keep the credential out of subsequent navigation URLs and referrers.
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!token) { setError(t("invalidLink")); return; }
    if (password !== confirmation) { setError(t("mismatch")); return; }
    if ([...password].length < 12 || new TextEncoder().encode(password).length > 72) {
      setError(t("passwordPolicy")); return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/auth/local/accept", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(t(response.status === 429 ? "rateLimited"
          : data.error?.message?.startsWith("Password") ? "passwordPolicy" : "invalidLink"));
        return;
      }
      setToken("");
      setPassword("");
      router.push("/login");
    } catch { setError(t("networkError")); }
    finally { setLoading(false); }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md"><CardContent className="p-6">
        <h1 className="mb-2 text-xl font-semibold">{t("acceptTitle")}</h1>
        <p className="mb-6 text-sm text-muted-foreground">{t("passwordPolicy")}</p>
        <form onSubmit={submit} onKeyDown={(e) => {
          if (e.key === "Enter" && isImeComposing(e)) e.preventDefault();
        }} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input id="password" type="password" autoComplete="new-password" value={password}
              onChange={(e) => setPassword(e.target.value)} required disabled={loading} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmation">{t("confirmation")}</Label>
            <Input id="confirmation" type="password" autoComplete="new-password" value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)} required disabled={loading} />
          </div>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>{loading ? t("saving") : t("acceptSubmit")}</Button>
          <Button type="button" variant="link" disabled={loading} onClick={() => router.push("/login")}>{t("back")}</Button>
        </form>
      </CardContent></Card>
    </div>
  );
}
