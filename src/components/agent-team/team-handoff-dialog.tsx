"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ProjectTeamMember } from "@/types/project-agent-team";
import { AgentSelect } from "@/components/agent-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { teamErrorKey, teamRequest } from "./team-request";

interface HandoffPreview {
  candidates: { uuid: string; title: string }[];
  count: number;
  confirmationToken: string;
  expiresAt: string;
}

export function TeamHandoffDialog({ projectUuid, leads, onClose, onSuccess }: {
  projectUuid: string;
  leads: ProjectTeamMember[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useTranslations("projectTeam");
  const labels = useTranslations("settings.teams");
  const [leadUuid, setLeadUuid] = useState("");
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function handoff(confirm: boolean) {
    if (pending.current || !leads.some((member) => member.agentUuid === leadUuid && member.eligible) || (confirm && !preview)) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await teamRequest<HandoffPreview>(`/api/projects/${projectUuid}/team/handoff`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirm ? { leadAgentUuid: leadUuid, confirmationToken: preview!.confirmationToken } : { leadAgentUuid: leadUuid, preview: true }),
      });
      if (confirm) {
        toast.success(t("handedOff"));
        onSuccess();
        onClose();
      } else setPreview(result);
    } catch (caught) {
      setError(t(teamErrorKey(caught)));
      setPreview(null);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !pending.current) onClose(); }}>
    <DialogContent className="max-h-[85svh] overflow-y-auto rounded-2xl sm:max-w-lg">
      <DialogHeader><DialogTitle>{t("handoff")}</DialogTitle><DialogDescription>{t("handoffDescription")}</DialogDescription></DialogHeader>
      <AgentSelect value={leadUuid} disabled={busy} ariaLabel={t("chooseLead")} placeholder={t("chooseLead")} emptyLabel={t("noLead")}
        agents={leads.map((member) => ({ uuid: member.agentUuid, name: member.agentName, disabled: !member.eligible, description: !member.eligible ? t("ineligible") : t(member.online ? "online" : "offline", { count: member.activeCount }) }))}
        onValueChange={(uuid) => { setLeadUuid(uuid); setPreview(null); setError(null); }} />
      {preview && <div className="space-y-3 border-t border-border pt-3" role="region" aria-label={t("preview")}>
        <p className="text-sm font-medium">{t("previewCount", { count: preview.count })}</p>
        <p className="text-xs text-muted-foreground">{t("expires", { time: new Date(preview.expiresAt).toLocaleTimeString() })}</p>
        <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">{preview.candidates.map((idea) => <li key={idea.uuid}>
          <Link className="underline" href={`/projects/${projectUuid}/dashboard/${idea.uuid}`} target="_blank" rel="noreferrer">{idea.title}</Link>
          <span className="block break-all font-mono text-xs text-muted-foreground">{idea.uuid}</span>
        </li>)}</ul>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={onClose}>{labels("cancel")}</Button>
        <Button variant={preview ? "outline" : "default"} disabled={busy || !leads.some((member) => member.agentUuid === leadUuid && member.eligible)} onClick={() => void handoff(false)}>{t(preview ? "refreshPreview" : "preview")}</Button>
        {preview && <Button disabled={busy} onClick={() => void handoff(true)}>{t("confirmHandoff")}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
