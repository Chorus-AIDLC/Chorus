"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2, Lock, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { AccessImpactPreview, type AccessImpact } from "@/components/access-impact-preview";

export type ProjectVisibility = "public" | "private";
export type ProjectAccessLevel = "viewer" | "editor" | "admin";
export type ProjectMemberRole = "viewer" | "editor" | "admin";

export interface ProjectMember {
  uuid: string;
  userUuid: string;
  name: string | null;
  email: string | null;
  role: ProjectMemberRole;
  createdAt: string;
  source?: "project" | "group" | "both";
  directRole?: ProjectMemberRole | null;
  inheritedRole?: ProjectMemberRole | null;
  effectiveRole?: ProjectMemberRole;
}

interface CompanyUser {
  uuid: string;
  name: string;
  email: string | null;
}

const ROLES: ProjectMemberRole[] = ["viewer", "editor", "admin"];

/** Server message for the last-admin invariant (project-member.service.ts). */
const LAST_ADMIN_MESSAGE = "A project must keep at least one admin";

interface ApiFailure {
  status: number;
  code?: string;
  message?: string;
}

/** Map an API failure to a localized `projectAccess.errors.*` key. */
export function accessErrorKey(failure: ApiFailure): string {
  if (failure.message?.startsWith(LAST_ADMIN_MESSAGE) || failure.message?.includes("keep at least one admin")) return "errors.lastAdmin";
  if (failure.status === 409 || failure.code === "CONFLICT") return "errors.alreadyMember";
  if (failure.message?.startsWith("User not found in this company")) return "errors.notInCompany";
  if (failure.status === 403 || failure.code === "FORBIDDEN") return "errors.forbidden";
  if (failure.status === 422 || failure.code === "VALIDATION_ERROR") return "errors.invalid";
  return "errors.generic";
}

async function callApi<T>(url: string, init?: RequestInit): Promise<
  { ok: true; data: T } | { ok: false; failure: ApiFailure }
> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (res.ok && body?.success === true) return { ok: true, data: body.data as T };
    return {
      ok: false,
      failure: { status: res.status, code: body?.error?.code, message: body?.error?.message },
    };
  } catch {
    return { ok: false, failure: { status: 0 } };
  }
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

interface ProjectAccessTabProps {
  projectUuid: string;
  visibility: ProjectVisibility;
  accessLevel: ProjectAccessLevel;
  onVisibilityChange: (visibility: ProjectVisibility) => void;
  // Called after any member mutation so the parent can re-read the caller's own
  // access level (e.g. an admin who just demoted or removed themself).
  onMembersChanged?: () => void;
  resourceType?: "projects" | "project-groups";
  canReadMembers?: boolean;
  publicAllowed?: boolean;
}

export function ProjectAccessTab({
  projectUuid,
  visibility,
  accessLevel,
  onVisibilityChange,
  onMembersChanged,
  resourceType = "projects",
  canReadMembers = true,
  publicAllowed = true,
}: ProjectAccessTabProps) {
  const t = useTranslations("projectAccess");
  const tGroup = useTranslations("projectGroups");
  const tImpact = useTranslations("accessImpact");
  const tCommon = useTranslations("common");
  const isAdmin = accessLevel === "admin";
  const baseUrl = `/api/${resourceType}/${projectUuid}`;
  const membersUrl = `${baseUrl}/members`;
  const isGroup = resourceType === "project-groups";

  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [busyMember, setBusyMember] = useState<string | null>(null);

  const [pendingVisibility, setPendingVisibility] = useState<ProjectVisibility | null>(null);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [preview, setPreview] = useState<AccessImpact | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const onPreviewLoaded = useCallback((value: AccessImpact | null) => setPreview(value), []);

  const loadMembers = useCallback(async () => {
    const result = await callApi<{ members: ProjectMember[] }>(membersUrl);
    if (result.ok) {
      setMembers(result.data.members);
      setMembersFailed(false);
    } else {
      setMembersFailed(true);
    }
  }, [membersUrl]);

  useEffect(() => {
    if (canReadMembers) void loadMembers();
  }, [loadMembers, canReadMembers]);

  const memberLabel = (m: Pick<ProjectMember, "name" | "email">) =>
    m.name || m.email || t("members.unnamed");
  const failureMessage = (failure: ApiFailure) => isGroup
    ? tGroup(failure.message?.includes("keep at least one admin") || failure.message?.includes("last group Admin") ? "lastAdmin" : failure.status === 403 ? "accessForbidden" : "accessFailed")
    : t(accessErrorKey(failure));

  const confirmVisibility = async () => {
    if (!pendingVisibility || !preview) return;
    setSavingVisibility(true);
    setVisibilityError(null);
    const result = await callApi(baseUrl, jsonInit("PATCH", {
      visibility: pendingVisibility,
      confirmationToken: preview.confirmationToken,
    }));
    setSavingVisibility(false);
    if (result.ok) {
      onVisibilityChange(pendingVisibility);
      toast.success(isGroup ? tGroup("visibilityUpdated") : t("visibilityUpdated"));
      setPendingVisibility(null);
      onMembersChanged?.();
    } else {
      const error = result.failure.status === 409
        ? tImpact("stale") : failureMessage(result.failure);
      setVisibilityError(error);
      toast.error(error);
      setPreview(null);
      setPreviewVersion((value) => value + 1);
    }
  };

  const changeRole = async (member: ProjectMember, role: ProjectMemberRole) => {
    const directRole = member.directRole === undefined ? member.role : member.directRole;
    if (!directRole || role === directRole) return;
    if (member.inheritedRole && ROLES.indexOf(role) < ROLES.indexOf(member.inheritedRole)) return;
    setMemberError(null);
    setBusyMember(member.userUuid);
    const result = await callApi(`${membersUrl}/${member.userUuid}`, jsonInit("PATCH", { role }));
    setBusyMember(null);
    if (result.ok) {
      await loadMembers();
      toast.success(t("roleUpdated"));
      onMembersChanged?.();
    } else {
      setMemberError(failureMessage(result.failure));
    }
  };

  const removeMember = async (member: ProjectMember) => {
    if (member.directRole === null || member.source === "group") return;
    setMemberError(null);
    setBusyMember(member.userUuid);
    const result = await callApi(`${membersUrl}/${member.userUuid}`, jsonInit("DELETE"));
    setBusyMember(null);
    if (result.ok) {
      await loadMembers();
      toast.success(t("memberRemoved"));
      onMembersChanged?.();
    } else {
      setMemberError(failureMessage(result.failure));
    }
  };

  const addMember = async (user: CompanyUser, role: ProjectMemberRole) => {
    setMemberError(null);
    const result = await callApi(membersUrl, jsonInit("POST", { userUuid: user.uuid, role }));
    if (result.ok) {
      toast.success(t("memberAdded"));
      onMembersChanged?.();
      await loadMembers();
      return true;
    }
    setMemberError(failureMessage(result.failure));
    return false;
  };

  const memberUuids = useMemo(
    () => new Set((members ?? []).filter((m) => m.directRole !== null && m.source !== "group").map((m) => m.userUuid)),
    [members],
  );

  return (
    <div className="flex min-w-0 flex-col gap-7" data-testid={isGroup ? "group-access-tab" : "project-access-tab"}>
      {!isAdmin && (
        <p className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-[12px] text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          {isGroup ? tGroup("accessReadOnly") : t("readOnlyHint")}
        </p>
      )}

      {/* Visibility */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 id="project-visibility-label" className="text-[14px] font-semibold text-foreground">
            {t("visibility.title")}
          </h3>
          <p className="text-[12px] text-muted-foreground">{isGroup ? tGroup("visibilityDescription") : t("visibility.description")}</p>
        </div>
        <RadioGroup
          aria-labelledby="project-visibility-label"
          value={visibility}
          disabled={!isAdmin || savingVisibility}
          onValueChange={(value) => {
            if (value !== visibility) {
              setPreview(null);
              setVisibilityError(null);
              setPendingVisibility(value as ProjectVisibility);
            }
          }}
          className="grid gap-2 sm:grid-cols-2"
        >
          {(["public", "private"] as const).map((option) => (
            <Label
              key={option}
              htmlFor={`project-visibility-${option}`}
              className={`flex items-start gap-3 rounded-lg border border-border bg-card p-3 font-normal transition-colors has-[[data-state=checked]]:border-primary ${
                isAdmin && !savingVisibility
                  ? "cursor-pointer hover:bg-accent"
                  : "cursor-not-allowed opacity-60"
              }`}
            >
              <RadioGroupItem id={`project-visibility-${option}`} value={option} disabled={option === "public" && !publicAllowed} className="mt-0.5 cursor-pointer disabled:cursor-not-allowed" />
              <span className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-foreground">
                  {t(`visibility.${option}`)}
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {isGroup ? tGroup(`${option}Hint`) : t(`visibility.${option}Hint`)}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </section>

      <AlertDialog
        open={pendingVisibility !== null}
        onOpenChange={(open) => {
          if (!open && !savingVisibility) setPendingVisibility(null);
        }}
      >
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isGroup ? tGroup(pendingVisibility === "private" ? "toPrivateTitle" : "toPublicTitle") : t(pendingVisibility === "private" ? "confirm.toPrivateTitle" : "confirm.toPublicTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isGroup ? tGroup(pendingVisibility === "private" ? "convertPrivateHint" : "convertPublicHint") : t(pendingVisibility === "private"
                ? "confirm.toPrivateDescription"
                : "confirm.toPublicDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingVisibility && (
            <AccessImpactPreview
              kind={isGroup ? "group" : "project"}
              key={previewVersion}
              url={`${baseUrl}/access-preview?visibility=${pendingVisibility}`}
              onLoaded={onPreviewLoaded}
            />
          )}
          {visibilityError && <p role="alert" className="text-sm text-destructive">{visibilityError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingVisibility}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={savingVisibility || !preview}
              onClick={(event) => {
                event.preventDefault();
                void confirmVisibility();
              }}
            >
              {savingVisibility && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("confirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Members */}
      {canReadMembers && <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-[14px] font-semibold text-foreground">{t("members.title")}</h3>
          <p className="text-[12px] text-muted-foreground">{isGroup ? tGroup("membersDescription") : t("members.description")}</p>
        </div>

        {memberError && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
          >
            {memberError}
          </div>
        )}

        {members === null ? (
          membersFailed ? (
            <p className="text-[12px] text-destructive">{t("members.loadFailed")}</p>
          ) : (
            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("members.loading")}
            </p>
          )
        ) : (
          <div className="min-w-0 rounded-lg border border-border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("members.name")}</TableHead>
                  <TableHead className="w-[100px] sm:w-[140px]">{t("members.role")}</TableHead>
                  {isAdmin && <TableHead className="w-[40px] p-1 text-right"><span className="sr-only">{t("members.actions")}</span></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isAdmin ? 3 : 2} className="text-center text-[12px] text-muted-foreground">
                      {t("members.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((member) => {
                    const label = memberLabel(member);
                    const busy = busyMember === member.userUuid;
                    const directRole = member.directRole === undefined ? member.role : member.directRole;
                    const inheritedOnly = member.source === "group" || directRole === null;
                    const floor = member.inheritedRole;
                    const effectiveRole = member.effectiveRole ?? member.role;
                    return (
                      <TableRow key={member.userUuid}>
                        <TableCell className="whitespace-normal">
                          <div className="flex min-w-0 flex-col">
                            <span className="break-words text-[13px] font-medium text-foreground">{label}</span>
                            {member.email && member.name && (
                              <span className="break-all text-[12px] text-muted-foreground">{member.email}</span>
                            )}
                            {!isGroup && (
                              <span className="break-words text-[11px] text-muted-foreground">
                                {t(`members.source.${member.source ?? "project"}`)}
                                {floor && ` · ${t("members.inheritedRole", { role: t(`roles.${floor}`) })}`}
                                {directRole && ` · ${t("members.directRole", { role: t(`roles.${directRole}`) })}`}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {isAdmin && !inheritedOnly ? (
                            <Select
                              value={directRole ?? member.role}
                              disabled={busy}
                              onValueChange={(role) => void changeRole(member, role as ProjectMemberRole)}
                            >
                              <SelectTrigger
                                size="sm"
                                className="w-full min-w-0 px-2"
                                aria-label={t("members.roleFor", { name: label })}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLES.map((role) => (
                                  <SelectItem key={role} value={role} disabled={!!floor && ROLES.indexOf(role) < ROLES.indexOf(floor)}>{t(`roles.${role}`)}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant="secondary">{t(`roles.${effectiveRole}`)}</Badge>
                          )}
                          {!isGroup && <p className="mt-1 whitespace-normal text-[11px] text-muted-foreground">{t("members.effectiveRole", { role: t(`roles.${effectiveRole}`) })}</p>}
                        </TableCell>
                        {isAdmin && (
                          <TableCell className="p-1 text-right">
                            {!inheritedOnly && (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy}
                              aria-label={t("members.remove", { name: label })}
                              onClick={() => void removeMember(member)}
                              className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {isAdmin && members !== null && (
          <AddMemberRow excludeUuids={memberUuids} onAdd={addMember} inheritedMembers={isGroup ? [] : members} />
        )}
      </section>}
    </div>
  );
}

interface AddMemberRowProps {
  excludeUuids: Set<string>;
  onAdd: (user: CompanyUser, role: ProjectMemberRole) => Promise<boolean>;
  inheritedMembers: ProjectMember[];
}

function AddMemberRow({ excludeUuids, onAdd, inheritedMembers }: AddMemberRowProps) {
  const t = useTranslations("projectAccess");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanyUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<CompanyUser | null>(null);
  const [role, setRole] = useState<ProjectMemberRole>("editor");
  const [adding, setAdding] = useState(false);
  const floor = inheritedMembers.find((m) => m.userUuid === selected?.uuid)?.inheritedRole;

  // Company users come from the mention search (the only company-user listing
  // exposed to non-super-admins); it only searches users for a non-empty query.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const result = await callApi<Array<{ type: string; uuid: string; name: string; email?: string | null }>>(
        `/api/mentionables?q=${encodeURIComponent(q)}&limit=20`,
      );
      if (cancelled) return;
      setSearching(false);
      setResults(result.ok
        ? result.data
          .filter((item) => item.type === "user")
          .map((item) => ({ uuid: item.uuid, name: item.name, email: item.email ?? null }))
        : []);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const candidates = results.filter((user) => !excludeUuids.has(user.uuid));

  const handleAdd = async () => {
    if (!selected || (floor && ROLES.indexOf(role) <= ROLES.indexOf(floor))) return;
    setAdding(true);
    const ok = await onAdd(selected, role);
    setAdding(false);
    if (ok) {
      setSelected(null);
      setQuery("");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <span className="text-[12px] font-medium text-muted-foreground">{t("add.title")}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label={t("add.selectUser")}
              className="w-full min-w-0 justify-between font-normal sm:w-auto sm:flex-1"
            >
              <span className={selected ? "truncate text-foreground" : "truncate text-muted-foreground"}>
                {selected ? selected.name : t("add.selectUser")}
              </span>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(300px,calc(100vw-3rem))] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder={t("add.searchPlaceholder")}
              />
              <CommandList>
                {!query.trim() ? (
                  <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">{t("add.typeToSearch")}</p>
                ) : searching ? (
                  <p className="flex items-center justify-center gap-2 px-3 py-4 text-[12px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("add.searching")}
                  </p>
                ) : (
                  <>
                    <CommandEmpty>{t("add.noResults")}</CommandEmpty>
                    <CommandGroup>
                      {candidates.map((user) => (
                        <CommandItem
                          key={user.uuid}
                          value={user.uuid}
                          onSelect={() => {
                            setSelected(user);
                            const inherited = inheritedMembers.find((m) => m.userUuid === user.uuid)?.inheritedRole;
                            setRole(inherited === "viewer" ? "editor" : inherited === "editor" ? "admin" : "editor");
                            setOpen(false);
                          }}
                        >
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-[13px]">{user.name}</span>
                            {user.email && (
                              <span className="truncate text-[11px] text-muted-foreground">{user.email}</span>
                            )}
                          </div>
                          {selected?.uuid === user.uuid && <Check className="h-4 w-4 text-primary" />}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Select value={role} onValueChange={(value) => setRole(value as ProjectMemberRole)}>
          <SelectTrigger className="w-[120px]" aria-label={t("add.role")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r} disabled={!!floor && ROLES.indexOf(r) <= ROLES.indexOf(floor)}>{t(`roles.${r}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => void handleAdd()} disabled={!selected || adding || (!!floor && ROLES.indexOf(role) <= ROLES.indexOf(floor))} className="gap-1.5">
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          {adding ? t("add.adding") : t("add.add")}
        </Button>
      </div>
    </div>
  );
}
