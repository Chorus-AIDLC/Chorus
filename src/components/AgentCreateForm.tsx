"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Check, X, AlertTriangle, ShieldAlert } from "lucide-react";

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

export interface AgentCreateFormProps {
  /** Called after the agent and API key are successfully created */
  onAgentCreated: (
    agent: { uuid: string; name: string; roles: string[] },
    apiKey: string
  ) => void;
  /** Server action to create the agent and key. Returns the raw API key on success. */
  createAgentAndKey: (input: {
    name: string;
    roles: string[];
    persona: string | null;
  }) => Promise<{ success: boolean; key?: string; agentUuid?: string; error?: string }>;
  /** Optional: called when the user closes/dismisses the form */
  onClose?: () => void;
}

export function AgentCreateForm({
  onAgentCreated,
  createAgentAndKey,
  onClose,
}: AgentCreateFormProps) {
  const t = useTranslations();

  // Form state
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [customPersona, setCustomPersona] = useState("");
  const [adminConfirmed, setAdminConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Success state
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const toggleRole = (role: string) => {
    setSelectedRoles((prev) => {
      const newRoles = prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role];
      // Reset admin confirmation if admin role is deselected
      if (role === "admin_agent" && prev.includes(role)) {
        setAdminConfirmed(false);
      }
      return newRoles;
    });
  };

  const selectPersonaPreset = (description: string) => {
    setCustomPersona(description);
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName || selectedRoles.length === 0) return;

    setSubmitting(true);
    try {
      const result = await createAgentAndKey({
        name: newKeyName,
        roles: selectedRoles,
        persona: customPersona || null,
      });

      if (result.success && result.key) {
        setCreatedKey(result.key);
        onAgentCreated(
          {
            uuid: result.agentUuid || "",
            name: newKeyName,
            roles: selectedRoles,
          },
          result.key
        );
      } else {
        console.error("Failed to create API key:", result.error);
      }
    } catch (error) {
      console.error("Failed to create API key:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const resetForm = () => {
    setNewKeyName("");
    setSelectedRoles([]);
    setCustomPersona("");
    setCreatedKey(null);
    setAdminConfirmed(false);
  };

  const handleClose = () => {
    resetForm();
    onClose?.();
  };

  // Get available persona presets based on selected roles
  const getAvailablePersonas = () => {
    const personas: { id: string; labelKey: string; descKey: string }[] = [];
    if (selectedRoles.includes("pm_agent")) {
      personas.push(...PM_PERSONAS);
    }
    if (selectedRoles.includes("developer_agent")) {
      personas.push(...DEV_PERSONAS);
    }
    if (selectedRoles.includes("admin_agent")) {
      personas.push(...ADMIN_PERSONAS);
    }
    return personas;
  };

  // Check if admin role is selected
  const hasAdminRole = selectedRoles.includes("admin_agent");

  if (createdKey) {
    // Success State
    return (
      <div className="p-6">
        <div className="mb-4 flex items-center gap-2 text-green-600">
          <Check className="h-5 w-5" />
          <span className="font-medium">{t("settings.apiKeyCreated")}</span>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("settings.apiKeyCreatedDesc")}
        </p>
        <div className="mb-4 flex items-center gap-2">
          <code className="flex-1 rounded bg-foreground px-3 py-2 font-mono text-sm text-background">
            {createdKey}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => copyToClipboard(createdKey)}
          >
            {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </div>
        <Button onClick={handleClose} className="w-full">
          {t("common.done")}
        </Button>
      </div>
    );
  }

  // Form State
  return (
    <form onSubmit={handleCreateKey}>
      {/* Modal Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-5">
        <h3 className="text-lg font-semibold text-foreground">
          {t("settings.createApiKey")}
        </h3>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Modal Body */}
      <div className="space-y-5 p-6">
        {/* Name Field */}
        <div className="space-y-2">
          <Label htmlFor="keyName" className="text-[13px]">
            {t("settings.name")}
          </Label>
          <Input
            id="keyName"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
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
              onClick={() => toggleRole("developer_agent")}
              className={`flex h-auto w-full items-start justify-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selectedRoles.includes("developer_agent")
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary"
              }`}
            >
              <div
                className={`mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded ${
                  selectedRoles.includes("developer_agent")
                    ? "bg-primary"
                    : "border-2 border-border"
                }`}
              >
                {selectedRoles.includes("developer_agent") && (
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
              onClick={() => toggleRole("pm_agent")}
              className={`flex h-auto w-full items-start justify-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selectedRoles.includes("pm_agent")
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary"
              }`}
            >
              <div
                className={`mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded ${
                  selectedRoles.includes("pm_agent")
                    ? "bg-primary"
                    : "border-2 border-border"
                }`}
              >
                {selectedRoles.includes("pm_agent") && (
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
              onClick={() => toggleRole("admin_agent")}
              className={`flex h-auto w-full items-start justify-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selectedRoles.includes("admin_agent")
                  ? "border-red-500 bg-red-50 dark:bg-red-950"
                  : "border-border hover:border-red-400"
              }`}
            >
              <div
                className={`mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded ${
                  selectedRoles.includes("admin_agent")
                    ? "bg-red-500"
                    : "border-2 border-red-300"
                }`}
              >
                {selectedRoles.includes("admin_agent") && (
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
          {hasAdminRole && (
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
                      id="adminConfirm"
                      checked={adminConfirmed}
                      onCheckedChange={(checked) => setAdminConfirmed(checked === true)}
                      className="border-red-300 data-[state=checked]:bg-red-600 data-[state=checked]:border-red-600"
                    />
                    <Label htmlFor="adminConfirm" className="cursor-pointer text-xs font-medium text-red-700 dark:text-red-300">
                      {t("settings.adminConfirmCheckbox")}
                    </Label>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Agent Persona - Always visible */}
        <div className="space-y-3">
          <Label className="text-[13px]">{t("settings.agentPersona")}</Label>
          <p className="text-xs text-muted-foreground">
            {selectedRoles.length > 0
              ? t("settings.agentPersonaDesc")
              : t("settings.agentPersonaDescNoRoles")}
          </p>

          {/* Persona Presets - Only show when roles are selected */}
          {selectedRoles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {getAvailablePersonas().map((persona) => (
                <Button
                  key={persona.id}
                  type="button"
                  variant={customPersona === t(persona.descKey) ? "default" : "outline"}
                  size="sm"
                  onClick={() =>
                    selectPersonaPreset(t(persona.descKey))
                  }
                  className="rounded-full"
                >
                  {t(persona.labelKey)}
                </Button>
              ))}
            </div>
          )}

          {/* Editable Persona Textarea - Always visible */}
          <Textarea
            value={customPersona}
            onChange={(e) => setCustomPersona(e.target.value)}
            placeholder={t("settings.personaPlaceholder")}
            rows={4}
          />
          <p className="text-[11px] text-muted-foreground">
            {selectedRoles.length > 0
              ? t("settings.personaHint")
              : t("settings.personaHintNoRoles")}
          </p>
        </div>
      </div>

      {/* Modal Footer */}
      <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
        {onClose && (
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
          >
            {t("common.cancel")}
          </Button>
        )}
        <Button
          type="submit"
          disabled={
            !newKeyName || selectedRoles.length === 0 || submitting ||
            (hasAdminRole && !adminConfirmed)
          }
          className={hasAdminRole ? "bg-red-600 hover:bg-red-700" : ""}
        >
          {submitting ? t("settings.creating") : t("settings.createApiKey")}
        </Button>
      </div>
    </form>
  );
}
