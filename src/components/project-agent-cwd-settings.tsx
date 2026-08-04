"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { FolderCog, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DirectoryBrowser,
  type DirectorySelection,
  validateDirectorySelection,
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
  connectionUuid: string;
  host: string;
  cwd: string;
  validationRequestUuid?: string;
}

export interface ProjectAgentCwdMutations {
  upserts: Array<ProjectAgentCwdDraft & { validationRequestUuid: string }>;
  clears: string[];
}

export interface ProjectAgentCwdSettingsHandle {
  validate: () => Promise<ProjectAgentCwdMutations | null>;
}

export const ProjectAgentCwdSettings = forwardRef<ProjectAgentCwdSettingsHandle, {
  projectUuid?: string;
  agentError?: { agentUuid: string; message: string } | null;
}>(function ProjectAgentCwdSettings({
  projectUuid,
  agentError,
}, ref) {
  const t = useTranslations();
  const [items, setItems] = useState<AgentCwdItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ProjectAgentCwdDraft>>({});
  const [clears, setClears] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

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

  const updateMutations = (next: Record<string, ProjectAgentCwdDraft>, nextClears: Set<string>) => {
    setDrafts(next);
    setClears(nextClears);
  };

  const select = (selection: DirectorySelection | null, agentUuid: string) => {
    if (!selection) return;
    const nextClears = new Set(clears);
    nextClears.delete(agentUuid);
    updateMutations({
      ...drafts,
      [agentUuid]: selection,
    }, nextClears);
    setValidationErrors((current) => {
      const next = { ...current };
      delete next[agentUuid];
      return next;
    });
  };

  const clear = (agentUuid: string) => {
    const next = { ...drafts };
    delete next[agentUuid];
    const nextClears = new Set(clears);
    if (projectUuid) nextClears.add(agentUuid);
    updateMutations(next, nextClears);
  };

  useImperativeHandle(ref, () => ({
    validate: async () => {
      const validated: ProjectAgentCwdMutations["upserts"] = [];
      for (const draft of Object.values(drafts)) {
        try {
          const result = await validateDirectorySelection(draft);
          validated.push(result);
          setDrafts((current) => ({
            ...current,
            [draft.agentUuid]: result,
          }));
        } catch (validationError) {
          const code = validationError instanceof Error
            ? validationError.message
            : "INTERNAL_ERROR";
          setValidationErrors((current) => ({
            ...current,
            [draft.agentUuid]: t(`directoryBrowser.errors.${code}`),
          }));
          setEditingAgent(draft.agentUuid);
          return null;
        }
      }
      return { upserts: validated, clears: [...clears] };
    },
  }), [clears, drafts, t]);

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
        const preference = clears.has(item.agent.uuid) ? null : draft
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
                    onClick={() => clear(item.agent.uuid)}
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
                  showConfirm={false}
                  onValidated={() => undefined}
                  onSelectionChange={(selection) => select(selection, item.agent.uuid)}
                />
                {(validationErrors[item.agent.uuid]
                  || agentError?.agentUuid === item.agent.uuid) && (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {validationErrors[item.agent.uuid] || agentError?.message}
                  </p>
                )}
              </div>
            )}
            {editingAgent !== item.agent.uuid
              && agentError?.agentUuid === item.agent.uuid && (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {agentError.message}
                </p>
              )}
          </div>
        );
      })}
    </div>
  );
});
