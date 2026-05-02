"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";
import { clientLogger } from "@/lib/logger-client";
import {
  AgentFormFields,
  type AgentFormPreset,
} from "@/components/AgentFormFields";
import type { AgentPermissionPickerChange } from "@/components/AgentPermissionPicker";
import type { Permission } from "@/lib/authz/types";

export interface AgentCreateFormProps {
  /** Called after the agent and API key are successfully created */
  onAgentCreated: (
    agent: {
      uuid: string;
      name: string;
      roles: string[];
      permissions: string[];
    },
    apiKey: string,
  ) => void;
  /** Server action to create the agent and key. Returns the raw API key on success. */
  createAgentAndKey: (input: {
    name: string;
    roles: string[];
    permissions?: string[];
    persona: string | null;
  }) => Promise<{ success: boolean; key?: string; agentUuid?: string; error?: string }>;
  /** Optional: called when the user closes/dismisses the form */
  onClose?: () => void;
  /**
   * Embedded mode: drop the modal chrome (header, cancel, own success page) so
   * callers (e.g. onboarding wizard) can compose the form inside their own card.
   * In embedded mode the form fires `onAgentCreated` immediately on success —
   * the parent is responsible for showing the API key to the user.
   */
  embedded?: boolean;
  /** Override the submit button label. Defaults to "Create API Key" / "Creating...". */
  submitLabel?: string;
  submittingLabel?: string;
}

export function AgentCreateForm({
  onAgentCreated,
  createAgentAndKey,
  onClose,
  embedded = false,
  submitLabel,
  submittingLabel,
}: AgentCreateFormProps) {
  const t = useTranslations();

  // Form state
  const [newKeyName, setNewKeyName] = useState("");
  // Default to admin_agent preset — matches the design (full access by default).
  const [preset, setPreset] = useState<AgentFormPreset>("admin_agent");
  const [roles, setRoles] = useState<string[]>(["admin_agent"]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [customPersona, setCustomPersona] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Success state
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handlePickerChange(next: AgentPermissionPickerChange) {
    setPreset(next.preset);
    setRoles(next.roles);
    setPermissions(next.permissions as Permission[]);
  }

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName) return;
    if (preset === "custom" && permissions.length === 0) return;

    setSubmitting(true);
    try {
      const result = await createAgentAndKey({
        name: newKeyName,
        roles,
        permissions: preset === "custom" ? permissions : [],
        persona: customPersona || null,
      });

      if (result.success && result.key) {
        if (!embedded) setCreatedKey(result.key);
        onAgentCreated(
          {
            uuid: result.agentUuid || "",
            name: newKeyName,
            roles,
            permissions: preset === "custom" ? permissions : [],
          },
          result.key,
        );
      } else {
        clientLogger.error("Failed to create API key:", result.error);
      }
    } catch (error) {
      clientLogger.error("Failed to create API key:", error);
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
      clientLogger.error("Failed to copy to clipboard:", error);
    }
  };

  const resetForm = () => {
    setNewKeyName("");
    setPreset("admin_agent");
    setRoles(["admin_agent"]);
    setPermissions([]);
    setCustomPersona("");
    setCreatedKey(null);
  };

  const handleClose = () => {
    resetForm();
    onClose?.();
  };

  if (createdKey && !embedded) {
    // Success State (modal only — embedded callers render their own success UX)
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
      {!embedded && (
        /* Modal Header */
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
      )}

      {/* Body */}
      <div className={embedded ? undefined : "p-6"}>
        <AgentFormFields
          name={newKeyName}
          onNameChange={setNewKeyName}
          preset={preset}
          permissions={permissions}
          onPermissionsChange={handlePickerChange}
          persona={customPersona}
          onPersonaChange={setCustomPersona}
          nameInputId="keyName"
          personaInputId="create-agent-persona"
        />
      </div>

      {/* Footer */}
      <div
        className={
          embedded
            ? "flex justify-end gap-3 pt-2"
            : "flex justify-end gap-3 border-t border-border px-6 py-4"
        }
      >
        {!embedded && onClose && (
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
            !newKeyName ||
            (preset === "custom" && permissions.length === 0) ||
            submitting
          }
          className={embedded ? "w-full" : undefined}
          size={embedded ? "lg" : "default"}
        >
          {submitting
            ? submittingLabel ?? t("settings.creating")
            : submitLabel ?? t("settings.createApiKey")}
        </Button>
      </div>
    </form>
  );
}
