"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, ChevronsUpDown, X, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";

interface ProposalSummary {
  uuid: string;
  title: string;
  sequenceNumber: number;
  taskCount: number;
}

interface ProposalFilterProps {
  projectUuid: string;
}

export function ProposalFilter({ projectUuid }: ProposalFilterProps) {
  const t = useTranslations("tasks");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = useState(false);
  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [selectedUuids, setSelectedUuids] = useState<Set<string>>(new Set());

  // Initialize selection from URL params
  useEffect(() => {
    const param = searchParams.get("proposalUuids");
    if (param) {
      setSelectedUuids(new Set(param.split(",").filter(Boolean)));
    } else {
      setSelectedUuids(new Set());
    }
  }, [searchParams]);

  // Fetch proposals
  useEffect(() => {
    let cancelled = false;
    async function fetchProposals() {
      try {
        const res = await fetch(
          `/api/projects/${projectUuid}/proposals/summary`
        );
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json.success) {
          setProposals(json.data);
        }
      } catch {
        // silently ignore fetch errors
      }
    }
    fetchProposals();
    return () => {
      cancelled = true;
    };
  }, [projectUuid]);

  const updateUrl = useCallback(
    (uuids: Set<string>) => {
      const params = new URLSearchParams(searchParams.toString());
      if (uuids.size > 0) {
        params.set("proposalUuids", Array.from(uuids).join(","));
      } else {
        params.delete("proposalUuids");
      }
      const query = params.toString();
      router.replace(`${pathname}${query ? `?${query}` : ""}`, {
        scroll: false,
      });
    },
    [router, pathname, searchParams]
  );

  const toggleProposal = useCallback(
    (uuid: string) => {
      setSelectedUuids((prev) => {
        const next = new Set(prev);
        if (next.has(uuid)) {
          next.delete(uuid);
        } else {
          next.add(uuid);
        }
        updateUrl(next);
        return next;
      });
    },
    [updateUrl]
  );

  const clearAll = useCallback(() => {
    setSelectedUuids(new Set());
    updateUrl(new Set());
  }, [updateUrl]);

  const hasSelection = selectedUuids.size > 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
        <FileText className="size-4" />
        <span>{t("proposalFilter.label")}:</span>
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className={cn(
              "justify-between gap-1 min-w-[120px] max-w-[200px] md:min-w-[160px] md:max-w-none",
              hasSelection && "border-[#C67A52] bg-[#FFF8F4]"
            )}
          >
            <span className="truncate">
              {hasSelection
                ? t("proposalFilter.filtered", {
                    filtered: selectedUuids.size,
                    total: proposals.length,
                  })
                : t("proposalFilter.allProposals")}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command>
            <CommandInput
              placeholder={t("proposalFilter.search")}
            />
            <CommandList>
              <CommandEmpty>{t("proposalFilter.noResults")}</CommandEmpty>
              <CommandGroup>
                {proposals.map((proposal) => {
                  const isSelected = selectedUuids.has(proposal.uuid);
                  return (
                    <CommandItem
                      key={proposal.uuid}
                      value={proposal.title}
                      onSelect={() => toggleProposal(proposal.uuid)}
                      className="flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                            isSelected
                              ? "border-[#C67A52] bg-[#C67A52] text-white"
                              : "border-muted-foreground/30"
                          )}
                        >
                          {isSelected && <Check className="size-3" />}
                        </div>
                        <span className="truncate">{proposal.title}</span>
                      </div>
                      <Badge variant="secondary" className="ml-2 shrink-0">
                        {t("proposalFilter.taskCount", {
                          count: proposal.taskCount,
                        })}
                      </Badge>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {hasSelection && (
        <>
          <div className="flex flex-wrap gap-1 max-w-full">
            {proposals
              .filter((p) => selectedUuids.has(p.uuid))
              .map((p) => (
                <Badge
                  key={p.uuid}
                  variant="outline"
                  className="gap-1 border-[#C67A52] bg-[#FFF8F4] text-[#C67A52]"
                >
                  {p.title}
                  <button
                    type="button"
                    className="ml-0.5 rounded-full hover:bg-[#C67A52]/20"
                    onClick={() => toggleProposal(p.uuid)}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
          </div>
          <Button
            variant="ghost"
            size="xs"
            onClick={clearAll}
            className="text-muted-foreground"
          >
            {t("proposalFilter.clear")}
          </Button>
        </>
      )}
    </div>
  );
}
