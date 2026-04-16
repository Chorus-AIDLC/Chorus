"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search, Command as CommandIcon, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ANIM, staggerItem } from "@/lib/animation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { clientLogger } from "@/lib/logger-client";

interface SearchResult {
  entityType: "task" | "idea" | "proposal" | "document" | "project" | "project_group";
  uuid: string;
  title: string;
  snippet?: string;
  status?: string;
  projectUuid?: string;
  projectName?: string;
  updatedAt: string;
}

interface SearchResponse {
  results: SearchResult[];
  counts: Record<string, number>;
}

interface GlobalSearchProps {
  currentProjectUuid?: string;
  currentProjectName?: string;
  currentGroupUuid?: string;
  currentGroupName?: string;
}

type EntityTypeFilter = "all" | "task" | "idea" | "proposal" | "document" | "project" | "project_group";
type SearchScope = "global" | "group" | "project";

const FILTER_TYPES: EntityTypeFilter[] = ["all", "task", "idea", "proposal", "document", "project"];

const BADGE_COLORS: Record<string, string> = {
  task: "bg-[#EBF5FF] text-[#2563EB] border-[#2563EB]/20",
  idea: "bg-[#FEF9C3] text-[#A16207] border-[#A16207]/20",
  proposal: "bg-[#FFF7ED] text-[#C67A52] border-[#C67A52]/20",
  document: "bg-[#F3E8FF] text-[#7C3AED] border-[#7C3AED]/20",
  project: "bg-[#ECFDF5] text-[#059669] border-[#059669]/20",
  project_group: "bg-[#F0FDFA] text-[#0D9488] border-[#0D9488]/20",
};

const FILTER_KEYS: Record<EntityTypeFilter, string> = {
  all: "filterAll",
  task: "filterTasks",
  idea: "filterIdeas",
  proposal: "filterProposals",
  document: "filterDocuments",
  project: "filterProjects",
  project_group: "filterProjects",
};

export function GlobalSearch({ currentProjectUuid, currentProjectName, currentGroupUuid, currentGroupName }: GlobalSearchProps) {
  const t = useTranslations("search");
  const tTime = useTranslations("time");
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>(
    currentProjectUuid ? "project" : currentGroupUuid ? "group" : "global"
  );
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<EntityTypeFilter>("all");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const debounceTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    setScope(currentProjectUuid ? "project" : currentGroupUuid ? "group" : "global");
  }, [currentProjectUuid, currentGroupUuid]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && !e.defaultPrevented) {
        e.preventDefault();
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery("");
      setResults([]);
      setActiveFilter("all");
    }
  }, [isOpen]);

  const performSearch = useCallback(async (searchQuery: string, searchScope: SearchScope, filter: EntityTypeFilter = "all") => {
    if (!searchQuery.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams({
        q: searchQuery.trim(),
        scope: searchScope,
        limit: "20",
      });

      if (searchScope === "project" && currentProjectUuid) {
        params.set("scopeUuid", currentProjectUuid);
      } else if (searchScope === "group" && currentGroupUuid) {
        params.set("scopeUuid", currentGroupUuid);
      }

      if (filter !== "all") {
        params.set("types", filter);
      }

      const response = await fetch(`/api/search?${params.toString()}`, {
        credentials: "include",
      });

      if (!response.ok) {
        clientLogger.error("Search failed:", response.status);
        setResults([]);
        return;
      }

      const data = await response.json();
      if (data.success) {
        setResults((data.data as SearchResponse).results);
      } else {
        setResults([]);
      }
    } catch (error) {
      clientLogger.error("Search error:", error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [currentProjectUuid, currentGroupUuid]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (value.trim()) {
      debounceTimerRef.current = setTimeout(() => {
        performSearch(value, scope, activeFilter);
      }, 300);
    } else {
      setResults([]);
      setLoading(false);
    }
  }, [scope, activeFilter, performSearch]);

  const handleScopeChange = useCallback((newScope: SearchScope) => {
    setScope(newScope);
    if (query.trim()) performSearch(query, newScope, activeFilter);
  }, [query, activeFilter, performSearch]);

  const handleFilterChange = useCallback((filter: EntityTypeFilter) => {
    setActiveFilter(filter);
    setSelectedIndex(0);
    if (query.trim()) performSearch(query, scope, filter);
  }, [query, scope, performSearch]);

  useEffect(() => { setSelectedIndex(0); }, [results]);

  const navigateToResult = useCallback((result: SearchResult) => {
    setIsOpen(false);
    switch (result.entityType) {
      case "task":
        if (result.projectUuid) router.push(`/projects/${result.projectUuid}/tasks/${result.uuid}`);
        break;
      case "idea":
        if (result.projectUuid) router.push(`/projects/${result.projectUuid}/ideas/${result.uuid}`);
        break;
      case "proposal":
        if (result.projectUuid) router.push(`/projects/${result.projectUuid}/proposals/${result.uuid}`);
        break;
      case "document":
        if (result.projectUuid) router.push(`/projects/${result.projectUuid}/documents/${result.uuid}`);
        break;
      case "project":
        router.push(`/projects/${result.uuid}/dashboard`);
        break;
      case "project_group":
        router.push(`/projects`);
        break;
    }
  }, [router]);

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => {
        const next = Math.min(prev + 1, results.length - 1);
        resultRefs.current[next]?.scrollIntoView({ block: "nearest" });
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => {
        const next = Math.max(prev - 1, 0);
        resultRefs.current[next]?.scrollIntoView({ block: "nearest" });
        return next;
      });
    } else if (e.key === "Enter" && results.length > 0) {
      e.preventDefault();
      navigateToResult(results[selectedIndex]);
    }
  };

  const formatRelativeTime = (dateString: string) => {
    const diffInSeconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
    if (diffInSeconds < 60) return tTime("justNow");
    if (diffInSeconds < 3600) return tTime("minutesAgo", { minutes: Math.floor(diffInSeconds / 60) });
    if (diffInSeconds < 86400) return tTime("hoursAgo", { hours: Math.floor(diffInSeconds / 3600) });
    return tTime("daysAgo", { days: Math.floor(diffInSeconds / 86400) });
  };

  return (
    <>
      {/* Trigger — icon on mobile, full bar on desktop */}
      <Button
        variant="outline"
        size="icon"
        onClick={() => setIsOpen(true)}
        className="md:w-full md:justify-start md:gap-3 h-9 md:px-3 text-muted-foreground font-normal"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="hidden md:inline truncate text-sm">{t("placeholder")}</span>
        <kbd className="ml-auto pointer-events-none hidden md:flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium">
          <CommandIcon className="h-3 w-3" />
          <span>K</span>
        </kbd>
      </Button>

      {/* Search Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent
          className="w-[calc(100vw-2rem)] sm:max-w-[600px] p-0 gap-0 overflow-hidden [&>button]:hidden [&>*]:min-w-0 top-4 sm:top-[20%] translate-y-0"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">{t("placeholder")}</DialogTitle>

          {/* Search Header */}
          <div className="flex items-center gap-2 border-b px-3 sm:px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              ref={inputRef}
              type="text"
              placeholder={t("placeholder")}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              className="border-0 shadow-none focus-visible:ring-0 h-8 px-0 text-sm min-w-0"
            />
            {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
            <Select value={scope} onValueChange={(value) => handleScopeChange(value as SearchScope)}>
              <SelectTrigger className="w-auto h-7 text-xs gap-1 border-dashed shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">{t("scopeGlobal")}</SelectItem>
                {currentGroupUuid && (
                  <SelectItem value="group">{currentGroupName || t("scopeGroup")}</SelectItem>
                )}
                {currentProjectUuid && (
                  <SelectItem value="project">{currentProjectName || t("scopeProject")}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Filter Tabs */}
          {query.trim() && (
            <div className="flex items-center gap-1 border-b px-4 py-2 overflow-x-auto">
              {FILTER_TYPES.map((filter) => (
                <Button
                  key={filter}
                  variant={activeFilter === filter ? "default" : "ghost"}
                  size="sm"
                  onClick={() => handleFilterChange(filter)}
                  className={cn(
                    "h-7 px-3 text-xs rounded-full shrink-0",
                    activeFilter === filter
                      ? "bg-foreground text-background hover:bg-foreground/90"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t(FILTER_KEYS[filter])}
                </Button>
              ))}
            </div>
          )}

          {/* Results */}
          <ScrollArea className="max-h-[400px]">
            <AnimatePresence mode="wait">
              {!query.trim() ? (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: ANIM.fast }}>
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    {t("placeholder")}
                  </div>
                </motion.div>
              ) : loading ? (
                <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: ANIM.fast }}>
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                    {t("placeholder")}...
                  </div>
                </motion.div>
              ) : results.length === 0 ? (
                <motion.div key="no-results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: ANIM.fast }}>
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    {t("noResults")}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key={`results-${activeFilter}`}
                  initial="initial"
                  animate="animate"
                  transition={{ staggerChildren: ANIM.staggerFast }}
                  className="p-2"
                >
                  {results.map((result, index) => (
                    <motion.div key={`${result.entityType}-${result.uuid}`} variants={staggerItem}>
                      <button
                        ref={(el) => { resultRefs.current[index] = el; }}
                        onClick={() => navigateToResult(result)}
                        onMouseEnter={() => setSelectedIndex(index)}
                        className={cn(
                          "block w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer overflow-hidden",
                          index === selectedIndex ? "bg-accent" : "hover:bg-accent/50"
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                          <Badge
                            variant="outline"
                            className={cn("text-[10px] px-1.5 py-0 shrink-0", BADGE_COLORS[result.entityType] || "bg-muted text-muted-foreground")}
                          >
                            {t(`entityType.${result.entityType}`)}
                          </Badge>
                          {result.status && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                              {result.status}
                            </Badge>
                          )}
                          {result.projectName && (
                            <span className="text-[10px] text-muted-foreground line-clamp-1 ml-auto">
                              {result.projectName}
                            </span>
                          )}
                        </div>
                        <div className="font-medium text-sm line-clamp-1 break-all">{result.title}</div>
                        {result.snippet && (
                          <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5 break-all">
                            {result.snippet}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground mt-1">
                          {formatRelativeTime(result.updatedAt)}
                        </div>
                      </button>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </ScrollArea>

          {/* Footer — desktop only */}
          <div className="hidden sm:flex items-center justify-between border-t px-4 py-2 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="rounded border px-1 py-0.5 font-mono">&#8593;</kbd>
                <kbd className="rounded border px-1 py-0.5 font-mono">&#8595;</kbd>
                {t("filterAll")}
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border px-1 py-0.5 font-mono">&#9166;</kbd>
                Open
              </span>
            </div>
            <span className="flex items-center gap-1">
              <kbd className="rounded border px-1 py-0.5 font-mono">Esc</kbd>
              Close
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
