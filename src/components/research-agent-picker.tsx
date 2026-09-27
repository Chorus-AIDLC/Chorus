"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InstancePicker, filterOnlineInstances, type InstanceCandidate } from "@/components/agent-presence/instance-picker";
import { FixedCwdAnchor } from "@/components/agent-presence/fixed-cwd-anchor";
import { getPmAgentsAction, getAgentInstancesAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/actions";
import type { ResolvedProjectAgentCwdTarget } from "@/services/project-agent-cwd.service";

/** Reuse existing selection controls, but never call the lifecycle assignment actions. */
export function ResearchAgentPicker({ projectUuid, onConfirm, onCancel, onCloseAutoFocus }: {
  projectUuid: string;
  onConfirm: (selection: { agentUuid: string; instanceUuid?: string }) => void;
  onCancel: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations("research");
  const common = useTranslations("common");
  const id = useId();
  const [agents, setAgents] = useState<{ uuid: string; name: string }[]>([]);
  const [agentUuid, setAgentUuid] = useState("");
  const [instances, setInstances] = useState<InstanceCandidate[]>([]);
  const [selected, setSelected] = useState<InstanceCandidate | null>(null);
  const [target, setTarget] = useState<ResolvedProjectAgentCwdTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void getPmAgentsAction().then((result) => {
      if (current) setAgents(result.agents);
    }).catch(() => { if (current) setError("unknown"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!agentUuid) return;
    let current = true;
    setLoading(true);
    setSelected(null);
    setTarget(null);
    setInstances([]);
    setError(null);
    void getAgentInstancesAction(agentUuid, projectUuid).then((result) => {
      if (!current) return;
      setInstances(filterOnlineInstances(result.instances).filter((instance) => !!instance.agentInstanceUuid));
      setTarget(result.resolvedTarget);
    }).catch(() => { if (current) setError("unknown"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [agentUuid, projectUuid]);
  const fixed = target?.source === "project_fixed";
  const ready = !!agentUuid && !loading && (fixed ? target.availability === "ready" : !!selected?.agentInstanceUuid);
  return <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <DialogContent overlayClassName="z-[105]" className="z-[110] max-h-[85svh] overflow-y-auto" onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader>
        <DialogTitle>{t("selectAgent")}</DialogTitle>
        <DialogDescription>{t("selectionHint")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <Label htmlFor={id}>{t("agentLabel")}</Label>
        <Select value={agentUuid} onValueChange={setAgentUuid}>
          <SelectTrigger id={id} className="w-full"><SelectValue placeholder={t("selectAgent")} /></SelectTrigger>
          <SelectContent className="z-[120]">{agents.map((agent) => <SelectItem key={agent.uuid} value={agent.uuid}>{agent.name}</SelectItem>)}</SelectContent>
        </Select>
        {loading && <p role="status" className="text-sm text-muted-foreground">{t("loading")}</p>}
        {!loading && agents.length === 0 && <p className="text-sm text-muted-foreground">{t("noAgents")}</p>}
        {fixed && <FixedCwdAnchor target={target} />}
        {!fixed && !loading && agentUuid && <InstancePicker
          instances={instances} selectedConnectionUuid={selected?.connectionUuid ?? ""} onSelect={setSelected}
        />}
        {!loading && agentUuid && ((fixed && target.availability !== "ready") || (!fixed && instances.length === 0)) &&
          <p role="status" className="text-sm text-muted-foreground">{t("agent_offline")}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>{common("cancel")}</Button>
        <Button disabled={!ready} onClick={() => onConfirm({
          agentUuid, ...(!fixed && selected?.agentInstanceUuid ? { instanceUuid: selected.agentInstanceUuid } : {}),
        })}>{t("requestButton")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
