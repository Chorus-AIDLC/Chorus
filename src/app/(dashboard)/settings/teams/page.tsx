"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft, Plus, Users, LockKeyhole, Lightbulb, Code2, ShieldCheck, Compass, X, AlertTriangle } from "lucide-react";
import { authFetch } from "@/lib/auth-client";
import { isImeComposing } from "@/lib/ime";
import { AGENT_TEAM_ROLES, AGENT_TEAM_ROLE_DEFINITIONS, getAgentTeamRoleEligibility } from "@/lib/agent-team-roles";
import type { AgentTeamCandidateDto, AgentTeamDto, AgentTeamMemberInput, AgentTeamRole } from "@/types/agent-team";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AgentSelect } from "@/components/agent-select";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollableDialog, ScrollableDialogDescription, ScrollableDialogTitle } from "@/components/ui/scrollable-dialog";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type TeamApiError = { code?: string; details?: { members?: { role: AgentTeamRole; agentUuid: string; missingPermissions: string[] }[] } };

const roleIcons = { product: Lightbulb, development: Code2, review: ShieldCheck, lead: Compass };

async function teamRequest<Result>(url: string, init?: RequestInit): Promise<Result> {
  const response = await authFetch(url, { cache: "no-store", ...init });
  const result = await response.json();
  if (!response.ok || !result.success) throw result.error ?? {};
  return result.data;
}

function useTeamError() {
  const t = useTranslations("settings.teams");
  return (error: unknown) => {
    const code = (error as TeamApiError | null)?.code;
    if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return t("errors.denied");
    if (code === "NOT_FOUND") return t("errors.notFound");
    if (code === "VALIDATION_ERROR") return t("errors.invalid");
    return t("errors.request");
  };
}

function TeamEditor({ team, onClose, onSaved }: {
  team: AgentTeamDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("settings.teams");
  const errorMessage = useTeamError();
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [members, setMembers] = useState<AgentTeamMemberInput[]>(team?.members ?? []);
  const [currentTeam, setCurrentTeam] = useState(team);
  const [candidates, setCandidates] = useState<AgentTeamCandidateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    Promise.all([
      teamRequest<AgentTeamCandidateDto[]>("/api/agent-teams/candidates"),
      team ? teamRequest<AgentTeamDto>(`/api/agent-teams/${team.uuid}`) : Promise.resolve(null),
    ]).then(([nextCandidates, latestTeam]) => {
      if (!active) return;
      setCandidates(nextCandidates);
      setCurrentTeam(latestTeam);
      if (latestTeam) {
        setName(latestTeam.name);
        setDescription(latestTeam.description);
        setMembers(latestTeam.members);
      }
    }).catch((caught: unknown) => {
      if (!active) return;
      setError(caught);
      setLoadFailed(true);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [team, retry]);

  const toggleMember = (role: AgentTeamRole, agentUuid: string, selected: boolean) => {
    setMembers((previous) => selected
      ? [...previous, { role, agentUuid }]
      : previous.filter((member) => member.role !== role || member.agentUuid !== agentUuid));
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || loading || loadFailed || !name.trim()) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      await teamRequest(team ? `/api/agent-teams/${team.uuid}` : "/api/agent-teams", {
        method: team ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), members: members.map(({ role, agentUuid }) => ({ role, agentUuid })) }),
      });
      onSaved();
    } catch (caught) {
      setError(caught);
      const rejectedMembers = (caught as TeamApiError | null)?.details?.members;
      if (Array.isArray(rejectedMembers)) {
        setCandidates((previous) => previous.map((candidate) => ({
          ...candidate,
          effectivePermissions: candidate.effectivePermissions.filter((permission) => !rejectedMembers.some((member) => member.agentUuid === candidate.uuid && member.missingPermissions.includes(permission))),
        })));
      }
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  const memberErrors = (error as TeamApiError | null)?.details?.members;

  return (
    <ScrollableDialog
      open
      onOpenChange={(open) => { if (!open && !submitting.current) onClose(); }}
      showCloseButton={false}
      className="overflow-clip sm:max-w-3xl"
      header={<><ScrollableDialogTitle>{t(team ? "edit" : "create")}</ScrollableDialogTitle><ScrollableDialogDescription>{t("editorDescription")}</ScrollableDialogDescription></>}
      footer={<><Button variant="outline" onClick={onClose} disabled={saving}>{t("cancel")}</Button><Button type="submit" form="team-form" disabled={saving || loading || loadFailed || !name.trim()}>{t(saving ? "saving" : "save")}</Button></>}
    >
      {loading && <p role="status" className="py-4 text-muted-foreground">{t("loadingEditor")}</p>}
      {error != null && <div role="alert" className="mb-4 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        <p>{errorMessage(error)}</p>
        {Array.isArray(memberErrors) && memberErrors.map((member) => <p key={`${member.role}-${member.agentUuid}`}>
          {candidates.find((candidate) => candidate.uuid === member.agentUuid)?.name ?? member.agentUuid} · {t(`roles.${member.role}.name`)}: {t("missingPermissions", { permissions: member.missingPermissions.join(", ") })}
        </p>)}
        {loadFailed && <Button variant="outline" onClick={() => setRetry((previous) => previous + 1)}>{t("retry")}</Button>}
      </div>}
      <form id="team-form" onSubmit={save} onKeyDown={(event) => { if (event.key === "Enter" && isImeComposing(event)) event.preventDefault(); }} className="space-y-5" aria-busy={loading || saving}>
        <fieldset disabled={loading || loadFailed || saving} className="min-w-0 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="team-name">{t("name")}</Label><Input id="team-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required /></div>
            <div className="space-y-2"><Label htmlFor="team-description">{t("description")}</Label><Textarea id="team-description" className="min-h-9 resize-y" rows={1} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} /></div>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-5"><h3 className="text-sm font-semibold">{t("roleAssignments")}</h3><span className="text-xs text-muted-foreground">{t("optionalRoles")}</span></div>
          {!loading && !loadFailed && candidates.length === 0 && <div role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm"><p>{t("noAgents")}</p><Link href="/settings" className="mt-2 inline-block text-primary underline">{t("manageAgents")}</Link></div>}
          <div className="grid gap-3 sm:grid-cols-2">
          {AGENT_TEAM_ROLES.map((role) => {
            const RoleIcon = roleIcons[role];
            const options = [...candidates];
            for (const member of currentTeam?.members ?? []) {
              if (member.role === role && !options.some((candidate) => candidate.uuid === member.agentUuid)) {
                options.push({ uuid: member.agentUuid, name: member.agentName, effectivePermissions: [] });
              }
            }
            const roleOptions = options.map((candidate) => {
              const existing = currentTeam?.members.find((member) => member.role === role && member.agentUuid === candidate.uuid);
              const eligibility = existing && (loading || !existing.eligible) ? existing : getAgentTeamRoleEligibility(role, candidate.effectivePermissions);
              return { ...candidate, ...eligibility, existing, selected: members.some((member) => member.role === role && member.agentUuid === candidate.uuid) };
            });
            const selectedOptions = roleOptions.filter((candidate) => candidate.selected);
            return <fieldset key={role} aria-labelledby={`${role}-title`} aria-describedby={`${role}-description`} className="min-w-0 rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><RoleIcon className="size-4" aria-hidden="true" /></span>
                <h4 id={`${role}-title`} className="flex-1 text-sm font-semibold">{t(`roles.${role}.name`)}</h4>
                <span className="text-xs tabular-nums text-muted-foreground">{t("selectedCount", { count: selectedOptions.length })}</span>
              </div>
              <p id={`${role}-description`} className="mt-2 text-xs leading-relaxed text-muted-foreground">{t(`roles.${role}.description`)}</p>
              <div className="my-3 flex min-h-9 flex-wrap items-start gap-2">
                {selectedOptions.length === 0 && <p className="py-2 text-xs text-muted-foreground">{t("emptyRole")}</p>}
                {selectedOptions.map((candidate) => <div key={candidate.uuid} className={candidate.eligible ? "max-w-full" : "w-full rounded-lg border border-destructive/30 bg-destructive/5 p-2"}>
                  <div className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background py-1 pl-1.5 pr-1">
                    <AgentAvatar name={candidate.name} size={20} className="shrink-0 rounded-full" />
                    <span className="min-w-0 break-all text-xs font-medium">{candidate.name}</span>
                    {!candidate.eligible && <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />}
                    <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label={t("removeMember", { name: candidate.name })} aria-describedby={!candidate.eligible ? `${role}-${candidate.uuid}-missing` : undefined} onClick={() => toggleMember(role, candidate.uuid, false)}><X className="size-3" aria-hidden="true" /></Button>
                  </div>
                  {!candidate.eligible && <p id={`${role}-${candidate.uuid}-missing`} className="mt-2 break-words text-xs text-destructive">{t("missingPermissions", { permissions: candidate.missingPermissions.join(", ") })}{candidate.existing && ` ${t("retainedMember")}`}</p>}
                </div>)}
              </div>
              <AgentSelect agents={roleOptions.filter((candidate) => !candidate.selected).map((candidate) => ({ uuid: candidate.uuid, name: candidate.name, disabled: !candidate.eligible, description: candidate.eligible ? undefined : t("missingPermissions", { permissions: candidate.missingPermissions.join(", ") }) }))} value="" onValueChange={(uuid) => toggleMember(role, uuid, true)} placeholder={t("addAgent")} ariaLabel={t("addAgentToRole", { role: t(`roles.${role}.name`) })} emptyLabel={t("allAgentsAdded")} disabled={loading || loadFailed || saving} />
              <details className="mt-3 text-xs text-muted-foreground"><summary className="w-fit cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{t("permissionDetails")}</summary><p className="mt-2 break-words leading-relaxed">{t("requiredPermissions", { permissions: AGENT_TEAM_ROLE_DEFINITIONS[role].requiredPermissions.join(", ") })}</p></details>
            </fieldset>;
          })}
          </div>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{t("privacy")}</p>
        </fieldset>
      </form>
    </ScrollableDialog>
  );
}

export default function TeamsSettingsPage() {
  const t = useTranslations("settings.teams");
  const errorMessage = useTeamError();
  const [teams, setTeams] = useState<AgentTeamDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editor, setEditor] = useState<{ team: AgentTeamDto | null } | null>(null);
  const [deleting, setDeleting] = useState<AgentTeamDto | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const submitting = useRef(false);
  const requestNumber = useRef(0);

  const loadTeams = useCallback(async () => {
    const request = ++requestNumber.current;
    setLoading(true);
    setError(null);
    try {
      const nextTeams = await teamRequest<AgentTeamDto[]>("/api/agent-teams");
      if (request === requestNumber.current) setTeams(nextTeams);
    } catch (caught) {
      if (request === requestNumber.current) setError(caught);
    } finally {
      if (request === requestNumber.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTeams();
    return () => { requestNumber.current += 1; };
  }, [loadTeams]);

  async function deleteTeam() {
    if (!deleting || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setDeleteError(null);
    try {
      await teamRequest(`/api/agent-teams/${deleting.uuid}`, { method: "DELETE" });
      setDeleting(null);
      setNotice(t("deleted"));
      void loadTeams();
    } catch (caught) {
      setDeleteError(caught);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <Link href="/settings" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" aria-hidden="true" />{t("backToSettings")}</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p></div>
        <Button onClick={() => setEditor({ team: null })}><Plus className="size-4" aria-hidden="true" />{t("create")}</Button>
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />{t("privacy")}</p>
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {loading ? <p role="status" className="py-8 text-center text-muted-foreground">{t("loading")}</p> : error != null ? <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 p-4"><p className="text-sm text-destructive">{errorMessage(error)}</p><Button variant="outline" onClick={() => void loadTeams()}>{t("retry")}</Button></div> : teams.length === 0 ? <div className="rounded-lg border border-dashed border-border p-10 text-center"><Users aria-hidden="true" className="mx-auto mb-3 size-8 text-muted-foreground" /><h2 className="font-semibold text-foreground">{t("emptyTitle")}</h2><p className="mt-2 text-sm text-muted-foreground">{t("emptyDescription")}</p></div> : <div className="grid gap-4">
        {teams.map((team) => <Card key={team.uuid}>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1"><CardTitle className="break-words">{team.name}</CardTitle>{team.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{team.description}</p>}</div>
            <div className="flex gap-2"><Button variant="outline" onClick={() => setEditor({ team })} aria-label={t("editNamed", { name: team.name })}>{t("edit")}</Button><Button variant="outline" onClick={() => { setDeleteError(null); setDeleting(team); }} aria-label={t("deleteNamed", { name: team.name })}>{t("delete")}</Button></div>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {AGENT_TEAM_ROLES.map((role) => {
              const RoleIcon = roleIcons[role];
              return <section key={role} aria-label={t(`roles.${role}.name`)} className="min-w-0 rounded-lg bg-muted/40 p-3"><h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><RoleIcon className="size-3.5" aria-hidden="true" />{t(`roles.${role}.name`)}</h3><ul className="mt-3 space-y-2 text-sm">
                {team.members.filter((member) => member.role === role).map((member) => <li key={member.agentUuid}><span className="flex items-center gap-2"><AgentAvatar name={member.agentName} size={24} className="shrink-0 rounded-full" /><span className="min-w-0 break-all">{member.agentName}</span></span>{!member.eligible && <span className="mt-1 block break-words text-xs text-destructive">{t("missingPermissions", { permissions: member.missingPermissions.join(", ") })}</span>}</li>)}
              </ul>{!team.members.some((member) => member.role === role) && <p className="mt-3 text-xs text-muted-foreground">{t("emptyRole")}</p>}</section>;
            })}
          </CardContent>
        </Card>)}
      </div>}
      {editor && <TeamEditor team={editor.team} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setNotice(t("saved")); void loadTeams(); }} />}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open && !submitting.current) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t("confirmDeleteTitle")}</AlertDialogTitle><AlertDialogDescription>{t("confirmDeleteDescription", { name: deleting?.name ?? "" })}</AlertDialogDescription></AlertDialogHeader>
          {deleteError != null && <p role="alert" className="text-sm text-destructive">{errorMessage(deleteError)}</p>}
          <AlertDialogFooter><AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel><Button variant="destructive" disabled={busy} onClick={() => void deleteTeam()}>{t(busy ? "deleting" : "confirmDelete")}</Button></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
