"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronUp, Folder, HardDrive, Loader2, TextCursorInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isImeComposing } from "@/lib/ime";
import type { InstanceCandidate } from "./instance-picker";

type DirectoryItem = { name: string; path: string };
const DIRECTORY_ERROR_CODES = new Set([
  "HOST_OFFLINE",
  "TIMEOUT",
  "INVALID_PATH",
  "OUTSIDE_ROOT",
  "NOT_DIRECTORY",
  "ACCESS_DENIED",
  "STALE_TARGET",
  "LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
]);
const AUTOCOMPLETE_DELAY_MS = 250;

function normalizeDirectoryError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "ABORTED";
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  return DIRECTORY_ERROR_CODES.has(code) ? code : "INTERNAL_ERROR";
}

function separatorFor(path: string) {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function withTrailingSeparator(path: string) {
  const separator = separatorFor(path);
  return path.endsWith(separator) ? path : `${path}${separator}`;
}

function basenameAfterRoot(path: string, root: string) {
  const separator = separatorFor(root);
  const rootWithSeparator = withTrailingSeparator(root);
  if (path === root || path === rootWithSeparator) return "";
  if (!path.startsWith(rootWithSeparator)) return null;
  const tail = path.slice(rootWithSeparator.length);
  return tail.endsWith(separator) ? "" : tail.split(separator).at(-1) ?? "";
}

function parentWithinRoot(path: string, root: string) {
  const separator = separatorFor(root);
  const rootWithoutSeparator = root.endsWith(separator) && root.length > 1
    ? root.slice(0, -1)
    : root;
  const withoutTrailing = path.endsWith(separator) && path.length > rootWithoutSeparator.length
    ? path.slice(0, -1)
    : path;
  const parent = withoutTrailing.slice(0, withoutTrailing.lastIndexOf(separator));
  if (!parent || parent.length < rootWithoutSeparator.length) return rootWithoutSeparator;
  return parent.startsWith(withTrailingSeparator(rootWithoutSeparator))
    ? parent
    : rootWithoutSeparator;
}

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

function abortableDelay(signal: AbortSignal, delay: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function requestDirectory(
  payload: Record<string, unknown>,
  signal: AbortSignal,
) {
  const response = await fetch("/api/daemon-directory-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(body.error?.code ?? "INTERNAL_ERROR");
  }
  let request = body.data.request;
  while (request.status === "pending") {
    await abortableDelay(signal, 300);
    const poll = await fetch(
      `/api/daemon-directory-requests/${encodeURIComponent(request.uuid)}`,
      { signal },
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
  const hosts = useMemo(
    () => Array.from(
      new Map(instances.map((instance) => [instance.host, instance])).values(),
    ),
    [instances],
  );
  const [anchor, setAnchor] = useState<InstanceCandidate | null>(
    hosts.length === 1 ? hosts[0] : null,
  );
  const [roots, setRoots] = useState<string[]>([]);
  const [selectedRoot, setSelectedRoot] = useState("");
  const [pathMode, setPathMode] = useState<"daemon" | "custom">("custom");
  const [manualMode, setManualMode] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [items, setItems] = useState<DirectoryItem[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [listOpen, setListOpen] = useState(false);
  const [completedPrefix, setCompletedPrefix] = useState("");
  const [pending, setPending] = useState<"roots" | "browse" | "validate" | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const rootsGeneration = useRef(0);
  const browseGeneration = useRef(0);
  const validationGeneration = useRef(0);
  const rootsController = useRef<AbortController | null>(null);
  const browseController = useRef<AbortController | null>(null);
  const validationController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!listOpen || highlightedIndex < 0) return;
    document
      .getElementById(`directory-candidate-${highlightedIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedIndex, listOpen]);

  const clearCandidates = () => {
    browseGeneration.current += 1;
    browseController.current?.abort();
    setItems([]);
    setHighlightedIndex(-1);
    setListOpen(false);
    setCompletedPrefix("");
  };

  const cancelValidation = () => {
    validationGeneration.current += 1;
    validationController.current?.abort();
    setPending((current) => current === "validate" ? null : current);
  };

  useEffect(() => {
    rootsGeneration.current += 1;
    rootsController.current?.abort();
    cancelValidation();
    clearCandidates();
    setRoots([]);
    setSelectedRoot("");
    setPathMode("custom");
    setManualMode(false);
    setPrefix("");
    setSelectedPath("");
    setErrorCode(null);
    if (!anchor) {
      setPending(null);
      return;
    }

    const generation = rootsGeneration.current;
    const connectionUuid = anchor.connectionUuid;
    const controller = new AbortController();
    rootsController.current = controller;
    setPending("roots");
    void requestDirectory({
      operation: "roots",
      agentUuid,
      targetConnectionUuid: connectionUuid,
    }, controller.signal).then((request) => {
      if (
        generation !== rootsGeneration.current ||
        connectionUuid !== anchor.connectionUuid
      ) return;
      const nextRoots = request.result?.roots;
      if (!Array.isArray(nextRoots) || nextRoots.length === 0) {
        throw new Error("INTERNAL_ERROR");
      }
      setRoots(nextRoots);
      setSelectedRoot(nextRoots[0]);
      setManualMode(false);
      setPrefix(withTrailingSeparator(nextRoots[0]));
    }).catch((error) => {
      const code = normalizeDirectoryError(error);
      if (code !== "ABORTED" && generation === rootsGeneration.current) {
        setManualMode(true);
        setErrorCode(null);
      }
    }).finally(() => {
      if (generation === rootsGeneration.current) setPending(null);
    });

    return () => controller.abort();
  }, [agentUuid, anchor]);

  const basename = selectedRoot ? basenameAfterRoot(prefix, selectedRoot) : null;
  useEffect(() => {
    browseGeneration.current += 1;
    browseController.current?.abort();
    const generation = browseGeneration.current;
    setItems([]);
    setHighlightedIndex(-1);
    setListOpen(false);
    setCompletedPrefix("");
    if (!anchor || !selectedRoot || basename === null || basename.length === 0) {
      setPending((current) => current === "browse" ? null : current);
      return;
    }

    const connectionUuid = anchor.connectionUuid;
    const root = selectedRoot;
    const queryPrefix = prefix;
    const controller = new AbortController();
    browseController.current = controller;
    const timer = setTimeout(() => {
      setPending("browse");
      setErrorCode(null);
      void requestDirectory({
        operation: "list",
        agentUuid,
        targetConnectionUuid: connectionUuid,
        prefix: queryPrefix,
      }, controller.signal).then((request) => {
        if (
          generation !== browseGeneration.current ||
          connectionUuid !== anchor.connectionUuid ||
          root !== selectedRoot ||
          queryPrefix !== prefix
        ) return;
        const nextItems = Array.isArray(request.result?.items)
          ? request.result.items as DirectoryItem[]
          : [];
        setItems(nextItems);
        setHighlightedIndex(nextItems.length > 0 ? 0 : -1);
        setListOpen(nextItems.length > 0);
        setCompletedPrefix(queryPrefix);
      }).catch((error) => {
        const code = normalizeDirectoryError(error);
        if (code !== "ABORTED" && generation === browseGeneration.current) {
          setErrorCode(code);
          setCompletedPrefix(queryPrefix);
        }
      }).finally(() => {
        if (generation === browseGeneration.current) setPending(null);
      });
    }, AUTOCOMPLETE_DELAY_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [agentUuid, anchor, basename, prefix, selectedRoot]);

  useEffect(() => () => {
    rootsController.current?.abort();
    browseController.current?.abort();
    validationController.current?.abort();
  }, []);

  const chooseCandidate = (item: DirectoryItem) => {
    cancelValidation();
    clearCandidates();
    setSelectedPath(item.path);
    setPrefix(withTrailingSeparator(item.path));
    setErrorCode(null);
  };

  const validate = async () => {
    if (!anchor || !selectedPath) return;
    validationGeneration.current += 1;
    validationController.current?.abort();
    const generation = validationGeneration.current;
    const controller = new AbortController();
    validationController.current = controller;
    setPending("validate");
    setErrorCode(null);
    try {
      const request = await requestDirectory({
        operation: "validate",
        agentUuid,
        targetConnectionUuid: anchor.connectionUuid,
        cwd: selectedPath,
      }, controller.signal);
      const normalizedPath =
        typeof request.result?.normalizedPath === "string"
          ? request.result.normalizedPath
          : selectedPath;
      if (generation !== validationGeneration.current) return;
      await onValidated({
        agentUuid,
        connectionUuid: anchor.connectionUuid,
        host: anchor.host,
        cwd: normalizedPath,
        validationRequestUuid: request.uuid,
      });
    } catch (error) {
      const code = normalizeDirectoryError(error);
      if (code !== "ABORTED" && generation === validationGeneration.current) {
        setErrorCode(code);
      }
    } finally {
      if (generation === validationGeneration.current) setPending(null);
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
            className="h-11 max-w-full sm:h-8"
            onClick={() => {
              cancelValidation();
              setAnchor(host);
            }}
          >
            <span className="truncate">{host.host || t("unknownHost")}</span>
          </Button>
        ))}
      </div>

      {anchor && (
        <>
          <div
            className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"
            role="group"
            aria-label={t("chooseDirectorySource")}
          >
            <Button
              type="button"
              variant={pathMode === "daemon" ? "default" : "outline"}
              className="h-auto min-w-0 justify-start px-3 py-2 text-left"
              onClick={() => {
                cancelValidation();
                clearCandidates();
                setPathMode("daemon");
                setSelectedPath(anchor.cwd ?? "");
                setErrorCode(null);
              }}
            >
              <HardDrive className="mr-2 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{t("daemonCwd")}</span>
                <span className="block truncate font-mono text-[10px] opacity-75">
                  {anchor.cwd ?? t("unknownHost")}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant={pathMode === "custom" ? "default" : "outline"}
              className="h-auto min-w-0 justify-start px-3 py-2 text-left"
              onClick={() => {
                cancelValidation();
                setPathMode("custom");
                setSelectedPath("");
                setPrefix(selectedRoot ? withTrailingSeparator(selectedRoot) : "");
                setErrorCode(null);
              }}
            >
              <TextCursorInput className="mr-2 size-4 shrink-0" />
              <span className="text-xs font-medium">{t("customCwd")}</span>
            </Button>
          </div>

          {pending === "roots" && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("loadingRoots")}
            </p>
          )}

          {pathMode === "custom" && roots.length > 1 && (
            <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
              {t("browseRoot")}
              <select
                aria-label={t("browseRoot")}
                value={selectedRoot}
                className="h-11 min-w-0 rounded-md border border-input bg-background px-3 font-mono text-xs sm:h-9"
                onChange={(event) => {
                  cancelValidation();
                  clearCandidates();
                  setSelectedRoot(event.target.value);
                  setPrefix(withTrailingSeparator(event.target.value));
                  setSelectedPath("");
                  setErrorCode(null);
                }}
              >
                {roots.map((root) => <option key={root} value={root}>{root}</option>)}
              </select>
            </label>
          )}

          {pathMode === "custom" && (selectedRoot || manualMode) && (
            <div className="flex min-w-0 gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  role="combobox"
                  aria-label={t("pathPrefix")}
                  aria-autocomplete={manualMode ? "none" : "list"}
                  aria-expanded={listOpen}
                  aria-controls={manualMode ? undefined : "directory-candidates"}
                  aria-activedescendant={
                    listOpen && highlightedIndex >= 0
                      ? `directory-candidate-${highlightedIndex}`
                      : undefined
                  }
                  value={prefix}
                  onChange={(event) => {
                    cancelValidation();
                    setPrefix(event.target.value);
                    setSelectedPath(manualMode ? event.target.value.trim() : "");
                    setErrorCode(null);
                  }}
                  onKeyDown={(event) => {
                    if (isImeComposing(event)) return;
                    if (event.key === "Escape" && listOpen) {
                      event.preventDefault();
                      setListOpen(false);
                      return;
                    }
                    if (items.length === 0 || !listOpen) return;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const direction = event.key === "ArrowDown" ? 1 : -1;
                      setHighlightedIndex((current) =>
                        (current + direction + items.length) % items.length);
                      return;
                    }
                    if (
                      (event.key === "Tab" || event.key === "Enter") &&
                      highlightedIndex >= 0
                    ) {
                      event.preventDefault();
                      chooseCandidate(items[highlightedIndex]);
                    }
                  }}
                  placeholder={t("pathPlaceholder")}
                  className="h-11 min-w-0 pr-9 font-mono text-xs sm:h-9"
                />
                {pending === "browse" && (
                  <Loader2
                    aria-label={t("loadingCandidates")}
                    className="absolute right-3 top-2.5 size-4 animate-spin text-muted-foreground"
                  />
                )}
              </div>
              {!manualMode && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-11 sm:size-9"
                  disabled={prefix === selectedRoot}
                  onClick={() => {
                    cancelValidation();
                    const parent = parentWithinRoot(prefix, selectedRoot);
                    clearCandidates();
                    setPrefix(withTrailingSeparator(parent));
                    setSelectedPath(parent);
                    setErrorCode(null);
                  }}
                  aria-label={t("parent")}
                  title={t("parent")}
                >
                  <ChevronUp className="size-4" />
                </Button>
              )}
            </div>
          )}

          {pathMode === "custom" && listOpen && items.length > 0 && (
            <div
              id="directory-candidates"
              role="listbox"
              className="max-h-40 overflow-y-auto rounded-md border border-border p-1"
            >
              {items.map((item, index) => (
                <button
                  id={`directory-candidate-${index}`}
                  key={item.path}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedIndex}
                  className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-muted aria-selected:bg-muted"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseCandidate(item)}
                >
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 break-all font-mono">{item.path}</span>
                </button>
              ))}
            </div>
          )}

          {pathMode === "custom" &&
            completedPrefix === prefix &&
            items.length === 0 &&
            pending === null &&
            !errorCode && (
              <p className="text-xs text-muted-foreground">{t("empty")}</p>
            )}

          {selectedPath && (
            <div className="min-w-0 rounded-md border border-border bg-muted/30 p-3">
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
            className="h-11 w-fit sm:h-8"
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
