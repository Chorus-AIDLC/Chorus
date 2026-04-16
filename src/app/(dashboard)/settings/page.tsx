"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Plus, Key, Check, X, Globe, AlertTriangle, ShieldAlert, ChevronDown, ChevronRight, Activity, Bell, Pencil, Rocket } from "lucide-react";
import Link from "next/link";
import { AgentCreateForm } from "@/components/AgentCreateForm";
import { Badge } from "@/components/ui/badge";
import { useLocale } from "@/contexts/locale-context";
import { getApiKeysAction, createAgentAndKeyAction, deleteApiKeyAction, getAgentSessionsAction, closeSessionAction, reopenSessionAction, updateAgentAction } from "./actions";
import type { SessionResponse } from "@/services/session.service";
import { locales, localeNames, type Locale } from "@/i18n/config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotificationPreferencesForm } from "@/components/notification-preferences-form";
import { clientLogger } from "@/lib/logger-client";

interface ApiKey {
  uuid: string;
  keyPrefix: string;
  name: string | null;
  lastUsed: string | null;
  expiresAt: string | null;
  createdAt: string;
  roles: string[];
  agentUuid: string;
  persona: string | null;
}

// PM Agent Persona presets (labels and descriptions use i18n keys)
const PM_PERSONAS = [
  { id: "dev_pm", labelKey: "personas.devPm", descKey: "personas.devPmDesc" },
  { id: "full_pm", labelKey: "personas.fullPm", descKey: "personas.fullPmDesc" },
  { id: "simple_pm", labelKey: "personas.simplePm", descKey: "personas.simplePmDesc" },
];

// Developer Agent Persona presets
const DEV_PERSONAS = [
  { id: "senior_dev", labelKey: "personas.seniorDev", descKey: "personas.seniorDevDesc" },
  { id: "fullstack_dev", labelKey: "personas.fullstackDev", descKey: "personas.fullstackDevDesc" },
  { id: "pragmatic_dev", labelKey: "personas.pragmaticDev", descKey: "personas.pragmaticDevDesc" },
];

// Admin Agent Persona presets
const ADMIN_PERSONAS = [
  { id: "careful_admin", labelKey: "personas.carefulAdmin", descKey: "personas.carefulAdminDesc" },
  { id: "efficient_admin", labelKey: "personas.efficientAdmin", descKey: "personas.efficientAdminDesc" },
];

export default function SettingsPage() {
  const t = useTranslations();
  const { locale, setLocale } = useLocale();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [keyToDelete, setKeyToDelete] = useState<string | null>(null);

  // Session state
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});
  const [agentSessions, setAgentSessions] = useState<Record<string, SessionResponse[]>>({});
  const [loadingSessions, setLoadingSessions] = useState<Record<string, boolean>>({});

  // Edit modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [editName, setEditName] = useState("");
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [editPersona, setEditPersona] = useState("");
  const [editAdminConfirmed, setEditAdminConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    try {
      const result = await getApiKeysAction();
      if (result.success && result.data) {
        setApiKeys(result.data);
      }
    } catch (error) {
      clientLogger.error("Failed to fetch API keys:", error);
    } finally {
      setLoading(false);
    }
  };

  const openDeleteConfirm = (uuid: string) => {
    setKeyToDelete(uuid);
    setDeleteConfirmOpen(true);
  };

  const handleDeleteKey = async () => {
    if (!keyToDelete) return;

    try {
      const result = await deleteApiKeyAction(keyToDelete);
      if (result.success) {
        setApiKeys(apiKeys.filter((k) => k.uuid !== keyToDelete));
      } else {
        clientLogger.error("Failed to delete API key:", result.error);
      }
    } catch (error) {
      clientLogger.error("Failed to delete API key:", error);
    } finally {
      setDeleteConfirmOpen(false);
      setKeyToDelete(null);
    }
  };

  const closeModal = () => {
    setShowModal(false);
  };

  const toggleSessions = async (agentUuid: string) => {
    const isExpanded = expandedSessions[agentUuid];
    setExpandedSessions((prev) => ({ ...prev, [agentUuid]: !isExpanded }));

    if (!isExpanded && !agentSessions[agentUuid]) {
      setLoadingSessions((prev) => ({ ...prev, [agentUuid]: true }));
      const result = await getAgentSessionsAction(agentUuid);
      if (result.success && result.data) {
        setAgentSessions((prev) => ({ ...prev, [agentUuid]: result.data! }));
      }
      setLoadingSessions((prev) => ({ ...prev, [agentUuid]: false }));
    }
  };

  const handleCloseSession = async (sessionUuid: string, agentUuid: string) => {
    const result = await closeSessionAction(sessionUuid);
    if (result.success) {
      setAgentSessions((prev) => ({
        ...prev,
        [agentUuid]: (prev[agentUuid] || []).map((s) =>
          s.uuid === sessionUuid ? { ...s, status: "closed" } : s
        ),
      }));
    }
  };

  const handleReopenSession = async (sessionUuid: string, agentUuid: string) => {
    const result = await reopenSessionAction(sessionUuid);
    if (result.success) {
      setAgentSessions((prev) => ({
        ...prev,
        [agentUuid]: (prev[agentUuid] || []).map((s) =>
          s.uuid === sessionUuid ? { ...s, status: "active", lastActiveAt: new Date().toISOString() } : s
        ),
      }));
    }
  };

  // Edit modal helpers
  const openEditModal = (key: ApiKey) => {
    setEditingKey(key);
    setEditName(key.name || "");
    setEditRoles([...key.roles]);
    setEditPersona(key.persona || "");
    setEditAdminConfirmed(key.roles.includes("admin_agent"));
    setShowEditModal(true);
  };

  const closeEditModal = () => {
    setShowEditModal(false);
    setEditingKey(null);
    setEditName("");
    setEditRoles([]);
    setEditPersona("");
    setEditAdminConfirmed(false);
  };

  const toggleEditRole = (role: string) => {
    setEditRoles((prev) => {
      const newRoles = prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role];
      if (role === "admin_agent" && prev.includes(role)) {
        setEditAdminConfirmed(false);
      }
      return newRoles;
    });
  };

  const getEditAvailablePersonas = () => {
    const personas: { id: string; labelKey: string; descKey: string }[] = [];
    if (editRoles.includes("pm_agent")) {
      personas.push(...PM_PERSONAS);
    }
    if (editRoles.includes("developer_agent")) {
      personas.push(...DEV_PERSONAS);
    }
    if (editRoles.includes("admin_agent")) {
      personas.push(...ADMIN_PERSONAS);
    }
    return personas;
  };

  const handleUpdateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingKey || !editName || editRoles.length === 0) return;

    setSaving(true);
    try {
      const result = await updateAgentAction({
        agentUuid: editingKey.agentUuid,
        name: editName,
        roles: editRoles,
        persona: editPersona || null,
      });

      if (result.success) {
        // Update local state to reflect changes
        setApiKeys((prev) =>
          prev.map((k) =>
            k.agentUuid === editingKey.agentUuid
              ? { ...k, name: editName, roles: editRoles, persona: editPersona || null }
              : k
          )
        );
        closeEditModal();
      } else {
        clientLogger.error("Failed to update agent:", result.error);
      }
    } catch (error) {
      clientLogger.error("Failed to update agent:", error);
    } finally {
      setSaving(false);
    }
  };

  const editHasAdminRole = editRoles.includes("admin_agent");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-[#6B6B6B]">{t("common.loading")}</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      {/* Breadcrumb */}
      <div className="mb-6 text-xs text-[#9A9A9A]">{t("settings.breadcrumb")}</div>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-[#2C2C2C]">{t("settings.title")}</h1>
        <p className="mt-1 text-[13px] text-[#6B6B6B]">
          {t("settings.subtitle")}
        </p>
      </div>

      {/* Language Section */}
      <div className="mb-8 space-y-4">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold text-foreground">{t("settings.language")}</h2>
        </div>
        <p className="text-[13px] text-muted-foreground">
          {t("settings.languageDesc")}
        </p>
        <div className="flex gap-3">
          {locales.map((loc) => (
            <Button
              key={loc}
              variant={locale === loc ? "default" : "outline"}
              size="sm"
              onClick={() => setLocale(loc as Locale)}
              className="min-w-[100px]"
            >
              {localeNames[loc]}
            </Button>
          ))}
        </div>
      </div>

      {/* Setup Guide Section */}
      <Card className="mb-8">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t("settings.setupGuide")}</CardTitle>
          </div>
          <CardDescription>
            {t("settings.setupGuideDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/onboarding">
            <Button variant="outline">
              {t("settings.openSetupGuide")}
            </Button>
          </Link>
        </CardContent>
      </Card>

      <div className="mb-8 border-t border-border" />

      {/* Agents Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">{t("settings.agents")}</h2>
          <Button onClick={() => setShowModal(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t("settings.createApiKey")}
          </Button>
        </div>

        <p className="text-[13px] text-muted-foreground">
          {t("settings.agentsDesc")}
        </p>

        {/* API Keys List */}
        {apiKeys.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
              <Key className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              {t("settings.noApiKeys")}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {apiKeys.map((key) => (
              <div
                key={key.uuid}
                className="rounded-xl border border-border bg-card p-5"
              >
                {/* Header Row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                        key.roles.includes("developer_agent")
                          ? "bg-green-100"
                          : "bg-primary/10"
                      }`}
                    >
                      <Key
                        className={`h-[18px] w-[18px] ${
                          key.roles.includes("developer_agent")
                            ? "text-green-600"
                            : "text-primary"
                        }`}
                      />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-foreground">
                        {key.name || key.keyPrefix + "..."}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {key.keyPrefix}... · {t("settings.created")}{" "}
                        {new Date(key.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEditModal(key)}
                    >
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      {t("settings.editAgent")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openDeleteConfirm(key.uuid)}
                      className="text-destructive hover:text-destructive"
                    >
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>

                {/* Roles Row */}
                <div className="mt-4 flex items-center gap-4">
                  <span className="text-xs text-muted-foreground">{t("settings.roles")}</span>
                  <div className="flex items-center gap-2">
                    {key.roles.includes("developer_agent") && (
                      <Badge variant="secondary" className="bg-blue-50 text-blue-700 hover:bg-blue-50 dark:bg-blue-950 dark:text-blue-300">
                        {t("settings.developerAgent")}
                      </Badge>
                    )}
                    {key.roles.includes("pm_agent") && (
                      <Badge variant="secondary" className="bg-orange-50 text-orange-700 hover:bg-orange-50 dark:bg-orange-950 dark:text-orange-300">
                        {t("settings.pmAgent")}
                      </Badge>
                    )}
                    {key.roles.includes("admin_agent") && (
                      <Badge variant="secondary" className="bg-red-50 text-red-700 hover:bg-red-50 dark:bg-red-950 dark:text-red-300">
                        {t("settings.adminAgent")}
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Sessions Section */}
                <div className="mt-4 border-t border-border pt-3">
                  <button
                    onClick={() => toggleSessions(key.agentUuid)}
                    className="flex w-full items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {expandedSessions[key.agentUuid] ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    <Activity className="h-3.5 w-3.5" />
                    <span>{t("sessions.title")}</span>
                    {agentSessions[key.agentUuid] && (
                      <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
                        {agentSessions[key.agentUuid].filter((s) => s.status === "active").length}
                      </Badge>
                    )}
                  </button>

                  {expandedSessions[key.agentUuid] && (
                    <div className="mt-2 space-y-2">
                      {loadingSessions[key.agentUuid] ? (
                        <div className="text-xs text-muted-foreground py-2">{t("common.loading")}</div>
                      ) : !agentSessions[key.agentUuid]?.length ? (
                        <div className="text-xs text-muted-foreground py-2 italic">{t("sessions.noSessions")}</div>
                      ) : (
                        agentSessions[key.agentUuid].map((session) => (
                          <div
                            key={session.uuid}
                            className={`flex items-center justify-between rounded-lg p-2.5 text-xs ${
                              session.status === "closed"
                                ? "bg-muted/50 text-muted-foreground"
                                : "bg-secondary"
                            }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <div
                                className={`h-2 w-2 rounded-full flex-shrink-0 ${
                                  session.status === "active"
                                    ? "bg-green-500"
                                    : session.status === "inactive"
                                      ? "bg-yellow-500"
                                      : "bg-gray-400"
                                }`}
                              />
                              <span className="font-medium truncate">{session.name}</span>
                              <Badge
                                variant="outline"
                                className={`text-[10px] h-4 px-1 ${
                                  session.status === "active"
                                    ? "border-green-300 text-green-700"
                                    : session.status === "inactive"
                                      ? "border-yellow-300 text-yellow-700"
                                      : "border-gray-300 text-gray-500"
                                }`}
                              >
                                {t(`sessions.status${session.status.charAt(0).toUpperCase() + session.status.slice(1)}`)}
                              </Badge>
                              <span className="text-muted-foreground">
                                {t("sessions.checkins", { count: session.checkins.length })}
                              </span>
                            </div>
                            {session.status === "closed" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[10px] text-green-600 hover:text-green-700"
                                onClick={() => handleReopenSession(session.uuid, key.agentUuid)}
                              >
                                {t("sessions.reopen")}
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[10px] text-destructive hover:text-destructive"
                                onClick={() => handleCloseSession(session.uuid, key.agentUuid)}
                              >
                                {t("sessions.close")}
                              </Button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mb-8 border-t border-border" />

      {/* Notifications Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t("notifications.preferences.title")}</CardTitle>
          </div>
          <CardDescription>
            {t("notifications.preferences.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NotificationPreferencesForm />
        </CardContent>
      </Card>

      {/* Create API Key Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
          <div className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl bg-card shadow-xl">
            <AgentCreateForm
              createAgentAndKey={createAgentAndKeyAction}
              onAgentCreated={() => {
                fetchApiKeys();
              }}
              onClose={closeModal}
            />
          </div>
        </div>
      )}

      {/* Edit Agent Modal */}
      {showEditModal && editingKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
          <div className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl bg-card shadow-xl">
            <form onSubmit={handleUpdateAgent}>
              {/* Modal Header */}
              <div className="flex items-center justify-between border-b border-border px-6 py-5">
                <h3 className="text-lg font-semibold text-foreground">
                  {t("settings.editAgent")}
                </h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={closeEditModal}
                  className="h-8 w-8"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {/* Modal Body */}
              <div className="space-y-5 p-6">
                {/* Name Field */}
                <div className="space-y-2">
                  <Label htmlFor="editName" className="text-[13px]">
                    {t("settings.name")}
                  </Label>
                  <Input
                    id="editName"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder={t("settings.namePlaceholder")}
                    className="border-[#E5E0D8]"
                    required
                  />
                </div>

                {/* Agent Roles */}
                <div className="space-y-3">
                  <Label className="text-[13px]">{t("settings.agentRoles")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.agentRolesDesc")}
                  </p>
                  <div className="space-y-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => toggleEditRole("developer_agent")}
                      className={`flex h-auto w-full items-start justify-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                        editRoles.includes("developer_agent")
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary"
                      }`}
                    >
                      <div
                        className={`mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded ${
                          editRoles.includes("developer_agent")
                            ? "bg-primary"
                            : "border-2 border-border"
                        }`}
                      >
                        {editRoles.includes("developer_agent") && (
                          <Check className="h-3 w-3 text-primary-foreground" strokeWidth={3} />
                        )}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          {t("settings.developerAgent")}
                        </div>
                        <div className="text-xs font-normal text-muted-foreground">
                          {t("settings.developerAgentDesc")}
                        </div>
                      </div>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => toggleEditRole("pm_agent")}
                      className={`flex h-auto w-full items-start justify-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                        editRoles.includes("pm_agent")
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary"
                      }`}
                    >
                      <div
                        className={`mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded ${
                          editRoles.includes("pm_agent")
                            ? "bg-primary"
                            : "border-2 border-border"
                        }`}
                      >
                        {editRoles.includes("pm_agent") && (
                          <Check className="h-3 w-3 text-primary-foreground" strokeWidth={3} />
                        )}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          {t("settings.pmAgent")}
                        </div>
                        <div className="text-xs font-normal text-muted-foreground">
                          {t("settings.pmAgentDesc")}
                        </div>
                      </div>
                    </Button>
                    {/* Admin Agent - with danger styling */}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => toggleEditRole("admin_agent")}
                      className={`flex h-auto w-full items-start justify-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                        editRoles.includes("admin_agent")
                          ? "border-red-500 bg-red-50 dark:bg-red-950"
                          : "border-border hover:border-red-400"
                      }`}
                    >
                      <div
                        className={`mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded ${
                          editRoles.includes("admin_agent")
                            ? "bg-red-500"
                            : "border-2 border-red-300"
                        }`}
                      >
                        {editRoles.includes("admin_agent") && (
                          <Check className="h-3 w-3 text-white" strokeWidth={3} />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
                          <ShieldAlert className="h-4 w-4" />
                          {t("settings.adminAgent")}
                        </div>
                        <div className="text-xs font-normal text-red-500/80 dark:text-red-400/80">
                          {t("settings.adminAgentDesc")}
                        </div>
                      </div>
                    </Button>
                  </div>

                  {/* Admin Warning Box */}
                  {editHasAdminRole && !editingKey.roles.includes("admin_agent") && (
                    <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 flex-shrink-0 text-red-600 dark:text-red-400" />
                        <div className="space-y-2">
                          <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                            {t("settings.adminWarningTitle")}
                          </p>
                          <p className="text-xs text-red-600 dark:text-red-400">
                            {t("settings.adminWarningDesc")}
                          </p>
                          <ul className="list-inside list-disc space-y-1 text-xs text-red-600 dark:text-red-400">
                            <li>{t("settings.adminWarningItem1")}</li>
                            <li>{t("settings.adminWarningItem2")}</li>
                            <li>{t("settings.adminWarningItem3")}</li>
                            <li>{t("settings.adminWarningItem4")}</li>
                          </ul>
                          <div className="mt-3 flex cursor-pointer items-center gap-2">
                            <Checkbox
                              id="editAdminConfirm"
                              checked={editAdminConfirmed}
                              onCheckedChange={(checked) => setEditAdminConfirmed(checked === true)}
                              className="border-red-300 data-[state=checked]:bg-red-600 data-[state=checked]:border-red-600"
                            />
                            <Label htmlFor="editAdminConfirm" className="cursor-pointer text-xs font-medium text-red-700 dark:text-red-300">
                              {t("settings.adminConfirmCheckbox")}
                            </Label>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Agent Persona */}
                <div className="space-y-3">
                  <Label className="text-[13px]">{t("settings.agentPersona")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {editRoles.length > 0
                      ? t("settings.agentPersonaDesc")
                      : t("settings.agentPersonaDescNoRoles")}
                  </p>

                  {/* Persona Presets */}
                  {editRoles.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {getEditAvailablePersonas().map((persona) => (
                        <Button
                          key={persona.id}
                          type="button"
                          variant={editPersona === t(persona.descKey) ? "default" : "outline"}
                          size="sm"
                          onClick={() => setEditPersona(t(persona.descKey))}
                          className="rounded-full"
                        >
                          {t(persona.labelKey)}
                        </Button>
                      ))}
                    </div>
                  )}

                  <Textarea
                    value={editPersona}
                    onChange={(e) => setEditPersona(e.target.value)}
                    placeholder={t("settings.personaPlaceholder")}
                    rows={4}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {editRoles.length > 0
                      ? t("settings.personaHint")
                      : t("settings.personaHintNoRoles")}
                  </p>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeEditModal}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !editName || editRoles.length === 0 || saving ||
                    (editHasAdminRole && !editingKey.roles.includes("admin_agent") && !editAdminConfirmed)
                  }
                  className={editHasAdminRole && !editingKey.roles.includes("admin_agent") ? "bg-red-600 hover:bg-red-700" : ""}
                >
                  {saving ? t("settings.saving") : t("settings.saveChanges")}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.confirmDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.confirmDeleteDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteKey}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
