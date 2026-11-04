"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft, Plus, Users, LockKeyhole, Ellipsis, Info } from "lucide-react";
import { toast } from "sonner";
import { TapTooltip, TeamRoleRow } from "@/components/agent-team";

import { authFetch } from "@/lib/auth-client";
import { isImeComposing } from "@/lib/ime";
import { AGENT_TEAM_ROLES, AGENT_TEAM_ROLE_DEFINITIONS, getAgentTeamRoleEligibility } from "@/lib/agent-team-roles";
import type { AgentTeamCandidateDto, AgentTeamDto, AgentTeamMemberInput, AgentTeamRole } from "@/types/agent-team";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollableDialog, ScrollableDialogDescription, ScrollableDialogTitle } from "@/components/ui/scrollable-dialog";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type TeamApiError = { code?: string; details?: { members?: { role: AgentTeamRole; agentUuid: string; missingPermissions: string[] }[] } };

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
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {AGENT_TEAM_ROLES.map((role) => {
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
            const permissions = t("requiredPermissions", { permissions: AGENT_TEAM_ROLE_DEFINITIONS[role].requiredPermissions.join(", ") });
            return <TeamRoleRow
              key={role}
              role={role}
              roleLabel={t(`roles.${role}.name`)}
              description={t(`roles.${role}.description`)}
              badge={<><TapTooltip content={permissions}>
                <span tabIndex={0} aria-label={t("permissionDetails")} aria-describedby={`${role}-permissions`} className="relative rounded-sm text-muted-foreground outline-none after:absolute after:-inset-2.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring"><Info className="size-3.5" aria-hidden="true" /></span>
              </TapTooltip><span id={`${role}-permissions`} className="sr-only">{permissions}</span></>}
              members={selectedOptions.map((candidate) => {
                const rejected = Array.isArray(memberErrors) ? memberErrors.find((member) => member.role === role && member.agentUuid === candidate.uuid) : undefined;
                return { uuid: candidate.uuid, name: candidate.name, ineligibleReason: rejected || !candidate.eligible
                  ? `${t("missingPermissions", { permissions: (rejected?.missingPermissions ?? candidate.missingPermissions).join(", ") })}${candidate.existing ? ` ${t("retainedMember")}` : ""}`
                  : undefined };
              })}
              addOptions={roleOptions.filter((candidate) => !candidate.selected).map((candidate) => ({ uuid: candidate.uuid, name: candidate.name, disabled: !candidate.eligible, description: candidate.eligible ? undefined : t("missingPermissions", { permissions: candidate.missingPermissions.join(", ") }) }))}
              addLabel={t("addAgentToRole", { role: t(`roles.${role}.name`) })}
              emptyLabel={t("allAgentsAdded")}
              emptyMembersLabel={t("emptyRole")}
              actionsLabel={t("permissionDetails")}
              removeLabel={(member) => t("removeMember", { name: member.name })}
              onAdd={(uuid) => toggleMember(role, uuid, true)}
              onRemove={(uuid) => toggleMember(role, uuid, false)}
              disabled={loading || loadFailed || saving}
            />;
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
      toast.success(t("deleted"));
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
        <Button size="sm" onClick={() => setEditor({ team: null })}><Plus className="size-4" aria-hidden="true" />{t("create")}</Button>
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />{t("privacy")}</p>
      {loading ? <p role="status" className="py-8 text-center text-muted-foreground">{t("loading")}</p> : error != null ? <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 p-4"><p className="text-sm text-destructive">{errorMessage(error)}</p><Button variant="outline" onClick={() => void loadTeams()}>{t("retry")}</Button></div> : teams.length === 0 ? <div className="rounded-lg border border-dashed border-border p-10 text-center"><Users aria-hidden="true" className="mx-auto mb-3 size-8 text-muted-foreground" /><h2 className="font-semibold text-foreground">{t("emptyTitle")}</h2><p className="mt-2 text-sm text-muted-foreground">{t("emptyDescription")}</p></div> : <div className="grid gap-4">
        {teams.map((team) => <Card key={team.uuid} className="min-w-0">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1"><CardTitle className="break-words">{team.name}</CardTitle>{team.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{team.description}</p>}</div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditor({ team })} aria-label={t("editNamed", { name: team.name })}>{t("edit")}</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-9 sm:size-8" aria-label={t("actionsNamed", { name: team.name })}><Ellipsis className="size-4" aria-hidden="true" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => { setDeleteError(null); setDeleting(team); }} aria-label={t("deleteNamed", { name: team.name })}>{t("delete")}</DropdownMenuItem></DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border rounded-xl border border-border bg-card">
              {AGENT_TEAM_ROLES.map((role) => <TeamRoleRow
                key={role}
                role={role}
                roleLabel={t(`roles.${role}.name`)}
                description={t(`roles.${role}.description`)}
                members={team.members.filter((member) => member.role === role).map((member) => ({ uuid: member.agentUuid, name: member.agentName, ineligibleReason: member.eligible ? undefined : t("missingPermissions", { permissions: member.missingPermissions.join(", ") }) }))}
                addLabel={t("addAgentToRole", { role: t(`roles.${role}.name`) })}
                emptyLabel={t("allAgentsAdded")}
                emptyMembersLabel={t("emptyRole")}
                actionsLabel={t("permissionDetails")}
                removeLabel={(member) => t("removeMember", { name: member.name })}
                readOnly
              />)}
            </div>
          </CardContent>
        </Card>)}
      </div>}
      {editor && <TeamEditor team={editor.team} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); toast.success(t("saved")); void loadTeams(); }} />}
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
