"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { credentialLinkUrl } from "@/lib/credential-link";
import { isImeComposing } from "@/lib/ime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CredentialLink, LocalUserDto } from "@/types/local-user";

type InvitationState = { user: LocalUserDto | null; manageable: boolean };
type Action = "reinvite" | "revoke" | "replace";

export function InitialAdminInvitation({ companyUuid }: { companyUuid: string }) {
  const t = useTranslations("admin.initialAdminInvitation");
  const fields = useTranslations("workspaceUsers");
  const locale = useLocale();
  const [state, setState] = useState<InvitationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [form, setForm] = useState({ username: "", email: "", name: "" });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<CredentialLink | null>(null);
  const [copyStatus, setCopyStatus] = useState<"" | "copied" | "copyFailed">("");
  const [copying, setCopying] = useState(false);
  const submitting = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setCopying(false);
    setCopyStatus("");
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/companies/${companyUuid}/initial-admin`, { cache: "no-store" });
      const result = await response.json();
      if (request !== generation.current) return;
      if (!response.ok || !result.success) { setState(null); setError(t("loadFailed")); return; }
      setState(result.data);
    } catch {
      if (request === generation.current) setError(t("loadFailed"));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [companyUuid, t]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  function open(next: Action) {
    if (submitting.current) return;
    setAction(next);
    setForm({ username: "", email: "", name: "" });
    setFormError("");
    setNotice("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || !state?.manageable || submitting.current) return;
    if (action === "replace" && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(form.username.trim()) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) || form.email.trim().length > 254 || form.name.trim().length > 200)) {
      setFormError(fields("errors.invalidInput")); return;
    }
    const request = ++generation.current;
    submitting.current = true;
    setBusy(true);
    setFormError("");
    setLink(null);
    setCopying(false);
    setCopyStatus("");
    try {
      const response = await fetch(`/api/admin/companies/${companyUuid}/initial-admin`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, expectedUserUuid: state.user?.uuid ?? null,
          ...(action === "replace" ? { initialAdmin: { username: form.username.trim(), email: form.email.trim(),
            ...(form.name.trim() ? { name: form.name.trim() } : {}) } } : {}),
        }),
      });
      const result = await response.json();
      if (request !== generation.current) return;
      if (!response.ok || !result.success) {
        setFormError(response.status === 409 ? t("stateChanged") : fields("errors.operationFailed"));
        return;
      }
      setState({ user: result.data.user, manageable: result.data.manageable });
      setAction(null);
      setNotice(t(action === "revoke" ? "revoked" : "issued"));
      if (result.data.credentialLink) setLink({ ...result.data.credentialLink,
        url: credentialLinkUrl(result.data.credentialLink.url, window.location.origin) });
    } catch {
      if (request === generation.current) setFormError(fields("errors.operationFailed"));
    } finally {
      submitting.current = false;
      if (request === generation.current) setBusy(false);
    }
  }

  async function copyLink() {
    if (!link?.url || copying) return;
    setCopying(true);
    const request = generation.current;
    try { await navigator.clipboard.writeText(link.url); if (request === generation.current) setCopyStatus("copied"); }
    catch { if (request === generation.current) setCopyStatus("copyFailed"); }
    finally { if (request === generation.current) setCopying(false); }
  }

  return <Card className="mb-6">
    <CardHeader><CardTitle className="text-sm font-medium">{t("title")}</CardTitle><CardDescription>{t("description")}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {loading && <p role="status" className="text-sm text-muted-foreground">{fields("loading")}</p>}
      {error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={() => void load()}>{fields("retry")}</Button></div>}
      {!loading && state && <>
        {state.user ? <div className="flex flex-wrap items-center gap-3"><div><p className="font-medium">{state.user.name || state.user.username}</p><p className="text-sm text-muted-foreground">{state.user.username} · {state.user.email}</p></div><Badge variant="secondary">{fields(`statuses.${state.user.status}`)}</Badge></div> : <p className="text-sm text-muted-foreground">{t("noInvitation")}</p>}
        {state.manageable ? <div className="flex flex-wrap gap-3">
          {state.user && <><Button variant="outline" disabled={busy} onClick={() => open("reinvite")}>{t("reinvite")}</Button><Button variant="destructive" disabled={busy} onClick={() => open("revoke")}>{t("revoke")}</Button></>}
          <Button variant="outline" disabled={busy} onClick={() => open("replace")}>{t(state.user ? "replace" : "invite")}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { setLink(null); setNotice(""); void load(); }}>{fields("retry")}</Button>
        </div> : <p className="text-sm text-muted-foreground">{t("activated")}</p>}
      </>}
      {notice && <p role="status" className="text-sm text-foreground">{notice}</p>}
      {link && <div className="space-y-2 rounded-md border p-4">
        <Label htmlFor="initial-admin-link">{fields("issuedLink")}</Label><Input id="initial-admin-link" value={link.url} readOnly onFocus={(event) => event.target.select()} />
        <p className="text-sm text-muted-foreground">{fields("expiresAt", { date: new Date(link.expiresAt).toLocaleString(locale) })}</p>
        <p className="text-sm text-muted-foreground">{fields("linkDescription")}</p>
        <Button variant="outline" disabled={copying || !link.url} onClick={() => void copyLink()}>{fields("copyLink")}</Button>
        {copyStatus && <p role={copyStatus === "copyFailed" ? "alert" : "status"}>{fields(copyStatus)}</p>}
      </div>}
    </CardContent>
    <Dialog open={!!action} onOpenChange={(value) => { if (!value && !submitting.current) setAction(null); }}><DialogContent onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}>
      {action && <><DialogHeader><DialogTitle>{t(action)}</DialogTitle><DialogDescription>{t(`${action}Help`)}</DialogDescription></DialogHeader>
        <form onSubmit={submit} onKeyDown={(event) => { if (event.key === "Enter" && isImeComposing(event)) event.preventDefault(); }} className="space-y-4">
          {action === "replace" && <>
            <div className="space-y-2"><Label htmlFor="replacement-username">{fields("fields.username")}</Label><Input id="replacement-username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required maxLength={64} disabled={busy} autoComplete="off" /><p className="text-xs text-muted-foreground">{fields("usernameHint")}</p></div>
            <div className="space-y-2"><Label htmlFor="replacement-email">{fields("fields.email")}</Label><Input id="replacement-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required maxLength={254} disabled={busy} autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="replacement-name">{fields("fields.name")}</Label><Input id="replacement-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={200} disabled={busy} autoComplete="off" /><p className="text-xs text-muted-foreground">{fields("nameHint")}</p></div>
          </>}
          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setAction(null)}>{fields("cancel")}</Button><Button type="submit" variant={action === "revoke" ? "destructive" : "default"} disabled={busy}>{fields(busy ? "saving" : "confirm")}</Button></DialogFooter>
        </form></>}
    </DialogContent></Dialog>
  </Card>;
}
