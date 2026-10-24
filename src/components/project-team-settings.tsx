"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { LockKeyhole, Users, X } from "lucide-react";
import { authFetch } from "@/lib/auth-client";
import { AGENT_TEAM_ROLES, getAgentTeamRoleEligibility, type AgentTeamRole } from "@/lib/agent-team-roles";
import type { AgentTeamCandidateDto, AgentTeamDto } from "@/types/agent-team";
import type { ProjectAgentTeamDto, ProjectTeamMember, ProjectTeamOverrides } from "@/types/project-agent-team";
import { useCanEditProject } from "@/contexts/project-access-context";
import { AgentSelect } from "@/components/agent-select";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollableDialog, ScrollableDialogDescription, ScrollableDialogTitle } from "@/components/ui/scrollable-dialog";

interface HandoffPreview {
  candidates: { uuid: string; title: string }[];
  count: number;
  confirmationToken: string;
  expiresAt: string;
}

async function request<Result>(url: string, init?: RequestInit): Promise<Result> {
  const response = await authFetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok || !body.success) throw body.error ?? {};
  return body.data;
}

export function ProjectTeamSettings({ projectUuid }: { projectUuid: string }) {
  const t = useTranslations("projectTeam");
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="outline" onClick={() => setOpen(true)}><Users className="size-4" aria-hidden="true" />{t("title")}</Button>
    {open && <ProjectTeamEditor projectUuid={projectUuid} onClose={() => setOpen(false)} />}
  </>;
}

export function ProjectTeamEditor({ projectUuid, onClose }: { projectUuid: string; onClose: () => void }) {
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
  const [notice, setNotice] = useState<string | null>(null);
  const [leadUuid, setLeadUuid] = useState("");
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [unbind, setUnbind] = useState(false);

  const acceptTeam = useCallback((next: ProjectAgentTeamDto | null) => {
    setTeam(next);
    setTemplateUuid(next?.templateUuid ?? "");
    setOverrides(next?.overrides ?? {});
    setDirty(false);
    setPreview(null);
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

  function edit(next: ProjectTeamOverrides) {
    setOverrides(next);
    setDirty(true);
    setPreview(null);
    setNotice(null);
  }

  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (caught) {
      const code = (caught as { code?: string })?.code;
      setError(t(code === "CONFLICT" ? "stale" : code === "VALIDATION_ERROR" ? "invalid" : code === "FORBIDDEN" ? "denied" : "failed"));
      setPreview(null);
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
      setLeadUuid("");
      setNotice(t("saved"));
    });
  }

  function handoff(confirm: boolean) {
    if (!canEdit || dirty || !team || !agents.some((agent) => agent.uuid === leadUuid && agent.effectivePermissions.includes("idea:write"))) return;
    void run(async () => {
      const result = await request<HandoffPreview>(`${endpoint}/handoff`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirm && preview ? { leadAgentUuid: leadUuid, confirmationToken: preview.confirmationToken } : { leadAgentUuid: leadUuid, preview: true }),
      });
      if (!confirm) setPreview(result);
      else {
        setPreview(null);
        setTeam({ ...team, handoffWarning: null });
        setNotice(t("handedOff"));
      }
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

  return <ScrollableDialog open onOpenChange={(next) => { if (!next && !pending.current) onClose(); }} className="sm:max-w-[850px]"
    header={<><ScrollableDialogTitle>{t("title")}</ScrollableDialogTitle><ScrollableDialogDescription>{t("description")}</ScrollableDialogDescription></>}
    footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button variant="outline" disabled={busy} onClick={onClose}>{labels("cancel")}</Button>
      <div className="flex gap-2">{team && <Button variant="outline" disabled={busy || loading} onClick={() => { setUnbind(true); setPreview(null); }}>{t("unbind")}</Button>}
        <Button disabled={busy || loading || loadFailed || !configured || !dirty} onClick={save}>{labels(busy ? "saving" : "save")}</Button></div>
    </div>}>
    <div className="space-y-5">
      <p className="flex gap-2 text-xs text-muted-foreground"><LockKeyhole className="size-4 shrink-0" aria-hidden="true" />{t("privacy")}</p>
      {loading ? <p role="status">{labels("loading")}</p> : loadFailed ? <div role="alert"><p>{t("loadFailed")}</p><Button variant="outline" onClick={() => void load()}>{labels("retry")}</Button></div> : <>
        <div className="space-y-2">
          <div className="flex flex-wrap justify-between gap-2"><label id="project-team-template" className="text-sm font-medium">{t("template")}</label><Link href="/settings/teams" className="text-sm text-primary underline">{t("manageTemplates")}</Link></div>
          <Select value={templateUuid} disabled={busy} onValueChange={(uuid) => { setTemplateUuid(uuid); edit({}); setLeadUuid(""); }}>
            <SelectTrigger aria-labelledby="project-team-template" className="w-full"><SelectValue placeholder={frozen ? team?.templateName : t("chooseTemplate")} /></SelectTrigger>
            <SelectContent className="z-[120]">{templates.map((item) => <SelectItem key={item.uuid} value={item.uuid}>{item.name}</SelectItem>)}{templates.length === 0 && <p className="p-3 text-sm text-muted-foreground">{t("noTemplates")}</p>}</SelectContent>
          </Select>
        </div>
        {frozen && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="status">{t("frozen", { name: team?.templateName ?? "" })}</p>}
        {!configured && <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{t("empty")}</p>}
        {configured && <div className="grid gap-3 sm:grid-cols-2">{AGENT_TEAM_ROLES.map((role) => {
          const members = membersFor(role);
          const overridden = overrides[role] !== undefined;
          return <section key={role} aria-label={labels(`roles.${role}.name`)} className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{labels(`roles.${role}.name`)}</h3><span className="text-xs text-muted-foreground">{t(overridden ? "overridden" : frozen ? "snapshot" : "inherited")}</span></div>
            <p className="text-xs text-muted-foreground">{labels(`roles.${role}.description`)}</p>
            <ul className="space-y-3">{members.map((member) => <li key={member.agentUuid}>
              <div className="flex items-center gap-2"><AgentAvatar name={member.agentName} size={24} className="shrink-0 rounded-full" /><span className="min-w-0 flex-1 break-all text-sm">{member.agentName}</span><Button size="icon" variant="ghost" disabled={busy} aria-label={labels("removeMember", { name: member.agentName })} onClick={() => edit({ ...overrides, [role]: members.filter((item) => item.agentUuid !== member.agentUuid).map((item) => item.agentUuid) })}><X className="size-4" aria-hidden="true" /></Button></div>
              <p className="text-xs text-muted-foreground">{team?.roles[role].some((item) => item.agentUuid === member.agentUuid) ? t(member.online ? "online" : "offline", { count: member.activeCount }) : t("checkOnSave")}</p>
              {!member.eligible && <p className="text-xs text-destructive">{!member.hasProjectAccess ? t("noAccess") : labels("missingPermissions", { permissions: member.missingPermissions.join(", ") })}</p>}
            </li>)}</ul>
            {members.length === 0 && <p className="text-xs text-muted-foreground">{t("emptyRole")}</p>}
            <AgentSelect value="" disabled={busy} ariaLabel={labels("addAgentToRole", { role: labels(`roles.${role}.name`) })} placeholder={labels("addAgent")} emptyLabel={labels("allAgentsAdded")} agents={agents.filter((agent) => !members.some((member) => member.agentUuid === agent.uuid)).map((agent) => {
              const eligibility = getAgentTeamRoleEligibility(role, agent.effectivePermissions);
              return { uuid: agent.uuid, name: agent.name, disabled: !eligibility.eligible || !canEdit, description: !canEdit ? t("noAccess") : !eligibility.eligible ? labels("missingPermissions", { permissions: eligibility.missingPermissions.join(", ") }) : undefined };
            })} onValueChange={(uuid) => edit({ ...overrides, [role]: [...members.map((member) => member.agentUuid), uuid] })} />
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || (overridden && overrides[role]?.length === 0)} onClick={() => edit({ ...overrides, [role]: [] })}>{t("clearRole")}</Button>{overridden && !frozen && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const next = { ...overrides }; delete next[role]; edit(next); }}>{t("reset")}</Button>}</div>
          </section>;
        })}</div>}
        {team?.handoffWarning && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><p>{t("warning", { name: team.handoffWarning.agentName ?? t("deletedAgent") })}</p><p>{t(`warningReasons.${team.handoffWarning.reason}`)}</p></div>}
        {team && <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t("handoff")}>
          <h3 className="font-medium">{t("handoff")}</h3><p className="text-xs text-muted-foreground">{t("handoffDescription")}</p>
          {!canEdit ? <p className="text-sm text-muted-foreground">{t("viewer")}</p> : <>
            {dirty && <p className="text-sm text-muted-foreground">{t("saveFirst")}</p>}
            <AgentSelect value={leadUuid} disabled={busy || dirty} ariaLabel={t("chooseLead")} placeholder={t("chooseLead")} emptyLabel={t("noLead")} agents={agents.map((agent) => ({ uuid: agent.uuid, name: agent.name, disabled: !agent.effectivePermissions.includes("idea:write"), description: !agent.effectivePermissions.includes("idea:write") ? t("ineligible") : undefined }))} onValueChange={(uuid) => { setLeadUuid(uuid); setPreview(null); }} />
            <Button variant="outline" disabled={busy || dirty || !leadUuid || !agents.some((agent) => agent.uuid === leadUuid && agent.effectivePermissions.includes("idea:write"))} onClick={() => handoff(false)}>{t(preview ? "refreshPreview" : "preview")}</Button>
            {preview && <div className="space-y-3 border-t border-border pt-3" role="region" aria-label={t("preview")}><p className="text-sm font-medium">{t("previewCount", { count: preview.count })}</p><p className="text-xs text-muted-foreground">{t("expires", { time: new Date(preview.expiresAt).toLocaleTimeString() })}</p><ul className="max-h-48 space-y-2 overflow-y-auto text-sm">{preview.candidates.map((idea) => <li key={idea.uuid}><Link className="underline" href={`/projects/${projectUuid}/dashboard/${idea.uuid}`} target="_blank" rel="noreferrer">{idea.title}</Link><span className="block break-all font-mono text-xs text-muted-foreground">{idea.uuid}</span></li>)}</ul><Button disabled={busy} onClick={() => handoff(true)}>{t("confirmHandoff")}</Button></div>}
          </>}
        </section>}
        {unbind && <section role="alert" className="space-y-3 rounded-lg border border-destructive/40 p-4"><p className="text-sm">{t("unbindDescription")}</p><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => setUnbind(false)}>{labels("cancel")}</Button><Button variant="destructive" disabled={busy} onClick={() => void run(async () => { await request(endpoint, { method: "DELETE" }); acceptTeam(null); setLeadUuid(""); setUnbind(false); setNotice(t("unbound")); })}>{t("confirmUnbind")}</Button></div></section>}
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    </div>
  </ScrollableDialog>;
}
