"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { authFetch } from "@/lib/auth-client";
import { isImeComposing } from "@/lib/ime";
import { useWorkspaceUsersAccess } from "@/components/workspace-users-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CredentialLink, LocalUserDto, LocalUserMutationResult } from "@/types/local-user";

type Action = "edit" | "grant" | "revoke" | "disable" | "enable" | "reset" | "reinvite" | "remove";
type UserDialog = { action: Action; user: LocalUserDto } | { action: "invite" };

export default function WorkspaceUsersPage() {
  const t = useTranslations("workspaceUsers");
  const locale = useLocale();
  const { access, retry: retryAccess } = useWorkspaceUsersAccess();
  const [users, setUsers] = useState<LocalUserDto[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [listError, setListError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<UserDialog | null>(null);
  const [form, setForm] = useState({ username: "", email: "", name: "", workspaceAdmin: false });
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const requestNumber = useRef(0);
  const [credentialLink, setCredentialLink] = useState<CredentialLink | null>(null);
  const [copyStatus, setCopyStatus] = useState<"" | "copied" | "copyFailed">("");
  const [copying, setCopying] = useState(false);

  const errorMessage = useCallback((result: { error?: { code?: string; message?: string } | string }) => {
    const error = typeof result.error === "object" ? result.error : undefined;
    if (error?.code === "FORBIDDEN" || error?.code === "UNAUTHORIZED") return t("deniedDescription");
    if (error?.message === "Cannot remove the last effective Workspace Admin") return t("errors.lastAdmin");
    if (error?.message === "Username or email already exists in this workspace") return t("errors.duplicate");
    if (error?.message === "Accept an invitation before activating this user") return t("errors.acceptFirst");
    if (error?.code === "NOT_FOUND") return t("errors.notFound");
    if (error?.code === "BAD_REQUEST" || error?.code === "VALIDATION_ERROR") return t("errors.invalidInput");
    return t("errors.operationFailed");
  }, [t]);

  const loadUsers = useCallback(async () => {
    const request = ++requestNumber.current;
    setLoading(true);
    setListError("");
    try {
      const response = await authFetch(`/api/workspace/users?page=${page}&pageSize=${pageSize}`, { cache: "no-store" });
      const result = await response.json();
      if (request !== requestNumber.current) return;
      if (response.status === 401 || response.status === 403) { setDenied(true); setUsers([]); return; }
      if (!response.ok || !result.success) { setListError(errorMessage(result)); return; }
      const count = result.meta.total as number;
      const lastPage = Math.max(1, Math.ceil(count / pageSize));
      if (page > lastPage) { setPage(lastPage); return; }
      setUsers(result.data);
      setTotal(count);
    } catch {
      if (request === requestNumber.current) setListError(t("errors.loadFailed"));
    } finally {
      if (request === requestNumber.current) setLoading(false);
    }
  }, [page, pageSize, errorMessage, t]);

  useEffect(() => {
    if (access === "allowed") void loadUsers();
    return () => { requestNumber.current += 1; };
  }, [access, loadUsers]);

  function openDialog(next: UserDialog) {
    setFormError("");
    setNotice("");
    setDialog(next);
    setForm(next.action === "invite" ? { username: "", email: "", name: "", workspaceAdmin: false } : {
      username: next.user.username, email: next.user.email, name: next.user.name ?? "", workspaceAdmin: next.user.workspaceAdmin,
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dialog || submitting.current) return;
    const action = dialog.action;
    if (action === "invite" || action === "edit") {
      if (!/^[a-zA-Z0-9._-]{3,64}$/.test(form.username.trim()) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) || form.email.trim().length > 254 || form.name.trim().length > 200) {
        setFormError(t("errors.invalidInput")); return;
      }
    }
    submitting.current = true;
    setBusy(true);
    setFormError("");
    try {
      const base = dialog.action === "invite" ? "/api/workspace/users" : `/api/workspace/users/${dialog.user.uuid}`;
      let url = base;
      let method = "PATCH";
      let body: Record<string, unknown> | undefined;
      if (action === "invite" || action === "edit") {
        body = { username: form.username.trim(), email: form.email.trim(), ...(form.name.trim() ? { name: form.name.trim() } : {}) };
        if (action === "invite") { method = "POST"; body.workspaceAdmin = form.workspaceAdmin; }
      } else if (action === "remove") method = "DELETE";
      else if (action === "reset" || action === "reinvite") {
        method = "POST"; url += "/credentials"; body = { purpose: action === "reset" ? "reset" : "invite" };
      } else if (action === "grant" || action === "revoke") body = { workspaceAdmin: action === "grant" };
      else body = { status: action === "enable" ? "active" : "disabled" };
      const response = await authFetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok || !result.success) { setFormError(errorMessage(result)); return; }
      const data = result.data as LocalUserMutationResult;
      setDialog(null);
      setNotice(t("operationSucceeded"));
      if (data.credentialLink) { setCredentialLink(data.credentialLink); setCopyStatus(""); }
      // Refresh errors are separate from mutation errors; never lose an issued link.
      void loadUsers();
    } catch {
      setFormError(t("errors.operationFailed"));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!credentialLink || copying) return;
    setCopying(true);
    try { await navigator.clipboard.writeText(credentialLink.url); setCopyStatus("copied"); }
    catch { setCopyStatus("copyFailed"); }
    finally { setCopying(false); }
  }

  const credentialDialog = (
    <Dialog open={!!credentialLink} onOpenChange={(open) => { if (!open) { setCredentialLink(null); setCopyStatus(""); } }}><DialogContent>
      <DialogHeader><DialogTitle>{t(credentialLink?.purpose === "reset" ? "resetLinkTitle" : "inviteLinkTitle")}</DialogTitle><DialogDescription>{t("linkDescription")}</DialogDescription></DialogHeader>
      <Label htmlFor="issued-credential-link">{t("issuedLink")}</Label><Input id="issued-credential-link" readOnly value={credentialLink?.url ?? ""} onFocus={(event) => event.target.select()} />
      <p className="text-sm text-muted-foreground">{t("expiresAt", { date: credentialLink ? new Date(credentialLink.expiresAt).toLocaleString(locale) : "" })}</p>
      {copyStatus && <p role={copyStatus === "copyFailed" ? "alert" : "status"} className={copyStatus === "copyFailed" ? "text-destructive" : "text-foreground"}>{t(copyStatus)}</p>}
      <DialogFooter><Button variant="outline" onClick={() => setCredentialLink(null)}>{t("close")}</Button><Button disabled={copying} onClick={() => void copyLink()}>{t("copyLink")}</Button></DialogFooter>
    </DialogContent></Dialog>
  );

  if (access === "loading") return <div className="p-6 text-muted-foreground" role="status">{t("loading")}</div>;
  if (access === "denied" || denied) return (
    <div className="space-y-4 p-6"><h1 className="text-2xl font-semibold">{t("deniedTitle")}</h1><p role="alert" className="text-muted-foreground">{t("deniedDescription")}</p><Button asChild variant="outline"><Link href="/settings">{t("backToSettings")}</Link></Button>{credentialDialog}</div>
  );
  if (access === "error") return <div className="space-y-4 p-6"><p role="alert">{t("errors.accessFailed")}</p><Button onClick={retryAccess}>{t("retry")}</Button></div>;

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const editing = dialog?.action === "invite" || dialog?.action === "edit";
  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("description")}</p></div><Button onClick={() => openDialog({ action: "invite" })}>{t("actions.invite")}</Button></div>
      {notice && <p role="status" className="text-sm text-foreground">{notice}</p>}
      {listError && <div className="flex items-center gap-3"><p role="alert" className="text-destructive">{listError}</p><Button variant="outline" onClick={() => void loadUsers()}>{t("retry")}</Button></div>}
      <Card><CardContent className="pt-6">
        <Table aria-label={t("title")}><TableHeader><TableRow><TableHead>{t("fields.username")}</TableHead><TableHead>{t("fields.name")}</TableHead><TableHead>{t("fields.email")}</TableHead><TableHead>{t("fields.role")}</TableHead><TableHead>{t("fields.status")}</TableHead><TableHead>{t("fields.actions")}</TableHead></TableRow></TableHeader>
          <TableBody>{loading ? <TableRow><TableCell colSpan={6} role="status">{t("loading")}</TableCell></TableRow> : users.length === 0 ? <TableRow><TableCell colSpan={6}>{t("empty")}</TableCell></TableRow> : users.map((user) => (
            <TableRow key={user.uuid}><TableCell className="font-medium">{user.username}</TableCell><TableCell>{user.name ?? t("noName")}</TableCell><TableCell>{user.email}</TableCell><TableCell>{t(user.workspaceAdmin ? "roles.admin" : "roles.member")}</TableCell><TableCell><Badge variant="secondary">{t(`statuses.${user.status}`)}</Badge></TableCell><TableCell>
              {user.status !== "deleted" && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t("actionsFor", { username: user.username })}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => openDialog({ action: "edit", user })}>{t("actions.edit")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openDialog({ action: user.workspaceAdmin ? "revoke" : "grant", user })}>{t(user.workspaceAdmin ? "actions.revoke" : "actions.grant")}</DropdownMenuItem>
                {(user.status === "active" || user.status === "invited") && <DropdownMenuItem onSelect={() => openDialog({ action: "disable", user })}>{t("actions.disable")}</DropdownMenuItem>}
                {user.status === "active" && <DropdownMenuItem onSelect={() => openDialog({ action: "reset", user })}>{t("actions.reset")}</DropdownMenuItem>}
                {user.status === "disabled" && <DropdownMenuItem onSelect={() => openDialog({ action: "enable", user })}>{t("actions.enable")}</DropdownMenuItem>}
                {user.status === "invited" && <DropdownMenuItem onSelect={() => openDialog({ action: "reinvite", user })}>{t("actions.reinvite")}</DropdownMenuItem>}
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => openDialog({ action: "remove", user })}>{t("actions.remove")}</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>}
            </TableCell></TableRow>
          ))}</TableBody></Table>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2"><Label htmlFor="users-page-size">{t("pageSize")}</Label><Select value={String(pageSize)} onValueChange={(value) => { setPage(1); setPageSize(Number(value)); }}><SelectTrigger id="users-page-size" className="w-20"><SelectValue /></SelectTrigger><SelectContent>{[10, 20, 50, 100].map((size) => <SelectItem value={String(size)} key={size}>{size}</SelectItem>)}</SelectContent></Select></div>
          <div className="flex items-center gap-3"><span className="text-sm text-muted-foreground">{t("pagination", { page, pages, total })}</span><Button variant="outline" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>{t("previous")}</Button><Button variant="outline" disabled={loading || page >= pages} onClick={() => setPage((value) => value + 1)}>{t("next")}</Button></div>
        </div>
      </CardContent></Card>
      <Dialog open={!!dialog} onOpenChange={(open) => { if (!open && !submitting.current) setDialog(null); }}><DialogContent onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}>
        {dialog && <><DialogHeader><DialogTitle>{t(`actions.${dialog.action}`)}</DialogTitle><DialogDescription>{editing ? t(dialog.action === "invite" ? "inviteDescription" : "editDescription") : t(`confirmations.${dialog.action}`, { username: dialog.user.username })}</DialogDescription></DialogHeader>
          <form onSubmit={submit} onKeyDown={(event) => { if (event.key === "Enter" && isImeComposing(event)) event.preventDefault(); }} className="space-y-4">
            {editing && <><div className="space-y-2"><Label htmlFor="local-username">{t("fields.username")}</Label><Input id="local-username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required maxLength={64} disabled={busy} autoComplete="off" /><p className="text-xs text-muted-foreground">{t("usernameHint")}</p></div><div className="space-y-2"><Label htmlFor="local-email">{t("fields.email")}</Label><Input id="local-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required maxLength={254} disabled={busy} autoComplete="off" /></div><div className="space-y-2"><Label htmlFor="local-name">{t("fields.name")}</Label><Input id="local-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={200} disabled={busy} autoComplete="off" /><p className="text-xs text-muted-foreground">{t("nameHint")}</p></div>{dialog.action === "invite" && <div className="flex items-center gap-2"><Checkbox id="local-admin" checked={form.workspaceAdmin} onCheckedChange={(checked) => setForm({ ...form, workspaceAdmin: checked === true })} disabled={busy} /><Label htmlFor="local-admin">{t("roles.admin")}</Label></div>}</>}
            {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
            <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>{t("cancel")}</Button><Button type="submit" variant={dialog.action === "remove" || dialog.action === "disable" || dialog.action === "revoke" ? "destructive" : "default"} disabled={busy}>{busy ? t("saving") : t(editing ? "save" : "confirm")}</Button></DialogFooter>
          </form></>}
      </DialogContent></Dialog>
      {credentialDialog}
    </div>
  );
}
