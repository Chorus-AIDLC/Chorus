"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FolderCog, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DirectoryBrowser,
  type ValidatedDirectory,
} from "@/components/agent-presence/directory-browser";
import type { InstanceCandidate } from "@/components/agent-presence/instance-picker";

interface AgentCwdItem {
  agent: { uuid: string; name: string };
  onlineInstances: InstanceCandidate[];
  preference: {
    host: string;
    cwd: string;
    status: "valid" | "offline" | "invalid";
  } | null;
}

export interface ProjectAgentCwdDraft {
  agentUuid: string;
  validationRequestUuid: string;
  host: string;
  cwd: string;
}

export function ProjectAgentCwdSettings({
  projectUuid,
  onDraftChange,
}: {
  projectUuid?: string;
  onDraftChange?: (drafts: ProjectAgentCwdDraft[]) => void;
}) {
  const t = useTranslations();
  const [items, setItems] = useState<AgentCwdItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ProjectAgentCwdDraft>>({});
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(projectUuid
        ? `/api/projects/${encodeURIComponent(projectUuid)}/agent-cwds`
        : "/api/projects/agent-cwd-options");
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error("load failed");
      setItems(body.data.agents);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [projectUuid]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateDrafts = (next: Record<string, ProjectAgentCwdDraft>) => {
    setDrafts(next);
    onDraftChange?.(Object.values(next));
  };

  const save = async (selection: ValidatedDirectory) => {
    if (!projectUuid) {
      updateDrafts({
        ...drafts,
        [selection.agentUuid]: {
          agentUuid: selection.agentUuid,
          validationRequestUuid: selection.validationRequestUuid,
          host: selection.host,
          cwd: selection.cwd,
        },
      });
      setEditingAgent(null);
      return;
    }
    const response = await fetch(`/api/projects/${encodeURIComponent(projectUuid)}/agent-cwds`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentUuid: selection.agentUuid,
        validationRequestUuid: selection.validationRequestUuid,
      }),
    });
    if (!response.ok) throw new Error("save failed");
    setEditingAgent(null);
    await load();
  };

  const clear = async (agentUuid: string) => {
    if (!projectUuid) {
      const next = { ...drafts };
      delete next[agentUuid];
      updateDrafts(next);
      return;
    }
    const response = await fetch(`/api/projects/${encodeURIComponent(projectUuid)}/agent-cwds`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentUuid }),
    });
    if (!response.ok) {
      setError(true);
      return;
    }
    await load();
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h3 className="text-[14px] font-semibold text-foreground">
          {t("projectSettings.agentCwds.title")}
        </h3>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {t("projectSettings.agentCwds.description")}
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("projectSettings.agentCwds.loading")}
        </div>
      )}
      {error && (
        <div className="flex items-center justify-between gap-3" role="alert">
          <span className="text-xs text-destructive">
            {t("projectSettings.agentCwds.loadFailed")}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
            <RotateCcw className="mr-2 size-3.5" />
            {t("common.retry")}
          </Button>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("projectSettings.agentCwds.emptyOnline")}
        </p>
      )}

      {items.map((item) => {
        const draft = drafts[item.agent.uuid];
        const preference = draft
          ? { host: draft.host, cwd: draft.cwd, status: "valid" as const }
          : item.preference;
        return (
          <div key={item.agent.uuid} className="min-w-0 rounded-lg border border-border p-4">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold">{item.agent.name}</p>
                {preference ? (
                  <>
                    <p className="mt-1 break-all font-mono text-[11px]">{preference.cwd}</p>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      {preference.host}
                    </p>
                    <p className={preference.status === "valid"
                      ? "mt-1 text-[11px] text-emerald-700 dark:text-emerald-400"
                      : "mt-1 text-[11px] text-destructive"}>
                      {t(`projectSettings.agentCwds.status.${preference.status}`)}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t("projectSettings.agentCwds.notConfigured")}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title={t(preference
                    ? "projectSettings.agentCwds.replace"
                    : "projectSettings.agentCwds.configure")}
                  aria-label={t(preference
                    ? "projectSettings.agentCwds.replace"
                    : "projectSettings.agentCwds.configure")}
                  onClick={() => setEditingAgent(
                    editingAgent === item.agent.uuid ? null : item.agent.uuid,
                  )}
                >
                  <FolderCog className="size-4" />
                </Button>
                {preference && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="text-destructive"
                    title={t("projectSettings.agentCwds.clear")}
                    aria-label={t("projectSettings.agentCwds.clear")}
                    onClick={() => void clear(item.agent.uuid)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            {editingAgent === item.agent.uuid && (
              <div className="mt-4 border-t border-border pt-4">
                <DirectoryBrowser
                  agentUuid={item.agent.uuid}
                  instances={item.onlineInstances}
                  confirmLabel={t("projectSettings.agentCwds.save")}
                  onValidated={save}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
