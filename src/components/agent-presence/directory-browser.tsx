"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Folder, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InstanceCandidate } from "./instance-picker";

type DirectoryItem = { name: string; path: string };

export interface ValidatedDirectory {
  agentUuid: string;
  connectionUuid: string;
  host: string;
  cwd: string;
  validationRequestUuid: string;
}

interface DirectoryBrowserProps {
  agentUuid: string;
  instances: InstanceCandidate[];
  onValidated: (selection: ValidatedDirectory) => void | Promise<void>;
  confirmLabel: string;
}

async function requestDirectory(payload: Record<string, unknown>) {
  const response = await fetch("/api/daemon-directory-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error?.code ?? "INTERNAL_ERROR");
  }
  let request = body.data.request;
  while (request.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const poll = await fetch(
      `/api/daemon-directory-requests/${encodeURIComponent(request.uuid)}`,
    );
    const pollBody = await poll.json();
    if (!poll.ok || !pollBody.success) {
      throw new Error(pollBody.error?.code ?? "INTERNAL_ERROR");
    }
    request = pollBody.data.request;
  }
  if (request.status !== "success") {
    throw new Error(request.errorCode ?? "INTERNAL_ERROR");
  }
  return request;
}

export function DirectoryBrowser({
  agentUuid,
  instances,
  onValidated,
  confirmLabel,
}: DirectoryBrowserProps) {
  const t = useTranslations("directoryBrowser");
  const hosts = Array.from(
    new Map(instances.map((instance) => [instance.host, instance])).values(),
  );
  const [anchor, setAnchor] = useState<InstanceCandidate | null>(
    hosts.length === 1 ? hosts[0] : null,
  );
  const [prefix, setPrefix] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [items, setItems] = useState<DirectoryItem[]>([]);
  const [pending, setPending] = useState<"browse" | "validate" | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const browse = async () => {
    if (!anchor || !prefix.trim()) return;
    setPending("browse");
    setErrorCode(null);
    try {
      const request = await requestDirectory({
        operation: "list",
        agentUuid,
        targetConnectionUuid: anchor.connectionUuid,
        prefix: prefix.trim(),
      });
      const result = request.result as { items?: DirectoryItem[] } | null;
      setItems(result?.items ?? []);
    } catch (error) {
      setItems([]);
      setErrorCode(error instanceof Error ? error.message : "INTERNAL_ERROR");
    } finally {
      setPending(null);
    }
  };

  const validate = async () => {
    if (!anchor || !selectedPath) return;
    setPending("validate");
    setErrorCode(null);
    try {
      const request = await requestDirectory({
        operation: "validate",
        agentUuid,
        targetConnectionUuid: anchor.connectionUuid,
        cwd: selectedPath,
      });
      const normalizedPath =
        typeof request.result?.normalizedPath === "string"
          ? request.result.normalizedPath
          : selectedPath;
      await onValidated({
        agentUuid,
        connectionUuid: anchor.connectionUuid,
        host: anchor.host,
        cwd: normalizedPath,
        validationRequestUuid: request.uuid,
      });
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : "INTERNAL_ERROR");
    } finally {
      setPending(null);
    }
  };

  if (hosts.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("noHosts")}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2" aria-label={t("chooseHost")}>
        {hosts.map((host) => (
          <Button
            key={host.connectionUuid}
            type="button"
            size="sm"
            variant={anchor?.connectionUuid === host.connectionUuid ? "default" : "outline"}
            className="max-w-full"
            onClick={() => {
              setAnchor(host);
              setItems([]);
              setSelectedPath("");
              setErrorCode(null);
            }}
          >
            <span className="truncate">{host.host || t("unknownHost")}</span>
          </Button>
        ))}
      </div>

      {anchor && (
        <>
          <div className="flex min-w-0 gap-2">
            <Input
              aria-label={t("pathPrefix")}
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void browse();
                }
              }}
              placeholder={t("pathPlaceholder")}
              className="min-w-0 font-mono text-xs"
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              disabled={!prefix.trim() || pending !== null}
              onClick={() => void browse()}
              aria-label={t("browse")}
              title={t("browse")}
            >
              {pending === "browse" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
            </Button>
          </div>

          {items.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-border p-1">
              {items.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => {
                    setSelectedPath(item.path);
                    setPrefix(`${item.path}/`);
                  }}
                >
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono" title={item.path}>
                    {item.path}
                  </span>
                </button>
              ))}
            </div>
          )}

          {items.length === 0 && prefix && pending === null && !errorCode && (
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
          )}

          {selectedPath && (
            <div className="min-w-0 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-[11px] font-medium text-muted-foreground">
                {t("selection")}
              </p>
              <p className="mt-1 break-all font-mono text-xs">{selectedPath}</p>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {anchor.host}
              </p>
            </div>
          )}

          {errorCode && (
            <p role="alert" className="text-xs text-destructive">
              {t(`errors.${errorCode}`)}
            </p>
          )}

          <Button
            type="button"
            size="sm"
            className="w-fit"
            disabled={!selectedPath || pending !== null}
            onClick={() => void validate()}
          >
            {pending === "validate" && <Loader2 className="mr-2 size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </>
      )}
    </div>
  );
}
