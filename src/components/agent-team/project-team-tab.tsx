"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { LockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { AGENT_TEAM_ROLES, getAgentTeamRoleEligibility, type AgentTeamRole } from "@/lib/agent-team-roles";
import type { AgentTeamCandidateDto, AgentTeamDto } from "@/types/agent-team";
import type { ProjectAgentTeamDto, ProjectTeamMember, ProjectTeamOverrides } from "@/types/project-agent-team";
import { useCanEditProject } from "@/contexts/project-access-context";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TeamRoleRow } from "./team-role-row";
import { TeamStatusBadge } from "./team-status-badge";
import { TeamHandoffDialog } from "./team-handoff-dialog";
import { teamRequest as request, teamErrorKey } from "./team-request";

export function ProjectTeamTab({ projectUuid, onDirtyChange, onBusyChange }: {
  projectUuid: string;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useTranslations("projectTeam");
  const labels = useTranslations("settings.teams");
  const canEdit = useCanEditProject();
  const endpoint = `/api/projects/${projectUuid}/team`;
  const [team, setTeam] = useState<ProjectAgentTeamDto | null>(null);
  const [templates, setTemplates] = useState<AgentTeamDto[]>([]);
  const [agents, setAgents] = useState<AgentTeamCandidateDto[]>([]);
  const [templateUuid, setTemplateUuid] = useState("");
  const [overrides, setOverrides] = useState<ProjectTeamOverrides>({});
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [unbindError, setUnbindError] = useState<string | null>(null);
  const [unbind, setUnbind] = useState(false);

  const acceptTeam = useCallback((next: ProjectAgentTeamDto | null) => {
    setTeam(next);
    setTemplateUuid(next?.templateUuid ?? "");
    setOverrides(next?.overrides ?? {});
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [result, nextTemplates, nextAgents] = await Promise.all([
        request<{ team: ProjectAgentTeamDto | null }>(endpoint),
        request<AgentTeamDto[]>("/api/agent-teams"),
        request<AgentTeamCandidateDto[]>("/api/agent-teams/candidates"),
      ]);
      acceptTeam(result.team);
      setTemplates(nextTemplates);
      setAgents(nextAgents);
      setError(null);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [endpoint, acceptTeam]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  function edit(next: ProjectTeamOverrides) {
    setOverrides(next);
    setDirty(true);
    setError(null);
  }

  async function run(work: () => Promise<void>, reportError = setError) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    reportError(null);
    try {
      await work();
    } catch (caught) {
      reportError(t(teamErrorKey(caught)));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function save() {
    void run(async () => {
      const result = await request<{ team: ProjectAgentTeamDto }>(endpoint, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateUuid: templateUuid || null, overrides }),
      });
      acceptTeam(result.team);
      toast.success(t("saved"));
    });
  }

  const template = templates.find((item) => item.uuid === templateUuid);
  const frozen = !!team?.frozen && !templateUuid;
  const configured = !!templateUuid || frozen;
  function membersFor(role: AgentTeamRole): ProjectTeamMember[] {
    const saved = team?.roles[role] ?? [];
    if (!dirty && team && overrides[role] === undefined) return saved;
    const memberUuids = overrides[role] ?? (frozen ? saved.map((member) => member.agentUuid) : template?.members.filter((member) => member.role === role).map((member) => member.agentUuid) ?? []);
    return memberUuids.map((agentUuid) => {
      const retained = saved.find((member) => member.agentUuid === agentUuid);
      const candidate = agents.find((agent) => agent.uuid === agentUuid);
      const eligibility = getAgentTeamRoleEligibility(role, candidate?.effectivePermissions ?? []);
      return retained ?? { agentUuid, agentName: candidate?.name ?? agentUuid, ...eligibility, eligible: eligibility.eligible && canEdit, hasProjectAccess: canEdit, online: false, activeCount: 0 };
    });
  }

  return <div className="space-y-5">
    <p className="text-sm text-muted-foreground">{t("description")}</p>
    <p className="flex gap-2 text-xs text-muted-foreground"><LockKeyhole className="size-4 shrink-0" aria-hidden="true" />{t("privacy")}</p>
    {loading ? <p role="status">{labels("loading")}</p> : loadFailed ? <div role="alert"><p>{t("loadFailed")}</p><Button variant="outline" onClick={() => void load()}>{labels("retry")}</Button></div> : <>
      <div className="space-y-2">
        <div className="flex flex-wrap justify-between gap-2"><label id="project-team-template" className="text-sm font-medium">{t("template")}</label><Link href="/settings/teams" className="text-sm text-primary underline">{t("manageTemplates")}</Link></div>
        <Select value={templateUuid} disabled={busy} onValueChange={(uuid) => { setTemplateUuid(uuid); edit({}); }}>
          <SelectTrigger aria-labelledby="project-team-template" className="w-full"><SelectValue placeholder={frozen ? team?.templateName : t("chooseTemplate")} /></SelectTrigger>
          <SelectContent className="z-[120]">{templates.map((item) => <SelectItem key={item.uuid} value={item.uuid}>{item.name}</SelectItem>)}{templates.length === 0 && <p className="p-3 text-sm text-muted-foreground">{t("noTemplates")}</p>}</SelectContent>
        </Select>
      </div>
      {frozen && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm dark:border-amber-400/40 dark:bg-amber-400/10" role="status">{t("frozen", { name: team?.templateName ?? "" })}</p>}
      {!configured && <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{t("empty")}</p>}
      {configured && <div className="divide-y divide-border rounded-xl border border-border bg-card">{AGENT_TEAM_ROLES.map((role) => {
        const members = membersFor(role);
        const overridden = overrides[role] !== undefined;
        const status = overridden ? "overridden" : frozen ? "snapshot" : "inherited";
        return <TeamRoleRow key={role} role={role} roleLabel={labels(`roles.${role}.name`)} description={labels(`roles.${role}.description`)} emptyMembersLabel={t("emptyRole")}
          badge={<TeamStatusBadge status={status} label={t(status)} />}
          members={members.map((member) => ({
            uuid: member.agentUuid, name: member.agentName, online: member.online,
            presenceLabel: team?.roles[role].some((saved) => saved.agentUuid === member.agentUuid) ? t(member.online ? "online" : "offline", { count: member.activeCount }) : t("checkOnSave"),
            ineligibleReason: member.eligible ? undefined : !member.hasProjectAccess ? t("noAccess") : labels("missingPermissions", { permissions: member.missingPermissions.join(", ") }),
          }))}
          addLabel={labels("addAgentToRole", { role: labels(`roles.${role}.name`) })} emptyLabel={labels("allAgentsAdded")}
          actionsLabel={t("roleActions", { role: labels(`roles.${role}.name`) })}
          removeLabel={(member) => labels("removeMember", { name: member.name })} disabled={busy}
          onRemove={(uuid) => edit({ ...overrides, [role]: members.filter((member) => member.agentUuid !== uuid).map((member) => member.agentUuid) })}
          onAdd={(uuid) => edit({ ...overrides, [role]: [...members.map((member) => member.agentUuid), uuid] })}
          addOptions={agents.filter((agent) => !members.some((member) => member.agentUuid === agent.uuid)).map((agent) => {
            const eligibility = getAgentTeamRoleEligibility(role, agent.effectivePermissions);
            return { uuid: agent.uuid, name: agent.name, disabled: !eligibility.eligible || !canEdit, description: !canEdit ? t("noAccess") : !eligibility.eligible ? labels("missingPermissions", { permissions: eligibility.missingPermissions.join(", ") }) : undefined };
          })}
          actions={<>
            <DropdownMenuItem disabled={overridden && overrides[role]?.length === 0} onSelect={() => edit({ ...overrides, [role]: [] })}>{t("clearRole")}</DropdownMenuItem>
            {overridden && !frozen && <DropdownMenuItem onSelect={() => { const next = { ...overrides }; delete next[role]; edit(next); }}>{t("reset")}</DropdownMenuItem>}
          </>} />;
      })}</div>}
      {team?.handoffWarning && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm dark:border-amber-400/40 dark:bg-amber-400/10"><p>{t("warning", { name: team.handoffWarning.agentName ?? t("deletedAgent") })}</p><p>{t(`warningReasons.${team.handoffWarning.reason}`)}</p></div>}
      {team && <div className="space-y-2 border-t border-border pt-4">
        <Button variant="outline" size="sm" disabled={busy || dirty || !canEdit} onClick={() => setHandoffOpen(true)}>{t("handoffAction")}</Button>
        {!canEdit ? <p className="text-xs text-muted-foreground">{t("viewer")}</p> : dirty && <p className="text-xs text-muted-foreground">{t("saveFirst")}</p>}
      </div>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
      <Button disabled={busy || loading || loadFailed || !configured || !dirty} onClick={save}>{labels(busy ? "saving" : "save")}</Button>
      {team && <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20" disabled={busy || loading} onClick={() => { setUnbindError(null); setUnbind(true); }}>{t("unbind")}</Button>}
    </div>
    <AlertDialog open={unbind} onOpenChange={(open) => { if (!pending.current) setUnbind(open); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t("unbind")}</AlertDialogTitle><AlertDialogDescription>{t("unbindDescription")}</AlertDialogDescription></AlertDialogHeader>
        {unbindError && <p role="alert" className="text-sm text-destructive">{unbindError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{labels("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={(event) => {
            event.preventDefault();
            void run(async () => {
              await request(endpoint, { method: "DELETE" });
              acceptTeam(null);
              setUnbind(false);
              toast.success(t("unbound"));
            }, setUnbindError);
          }}>{t("confirmUnbind")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {handoffOpen && team && <TeamHandoffDialog projectUuid={projectUuid} leads={team.roles.lead} onClose={() => setHandoffOpen(false)} onSuccess={() => setTeam({ ...team, handoffWarning: null })} />}
  </div>;
}
