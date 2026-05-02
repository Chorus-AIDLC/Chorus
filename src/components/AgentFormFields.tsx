"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AgentPermissionPicker,
  type AgentPermissionPickerChange,
} from "@/components/AgentPermissionPicker";
import { ROLE_PRESETS, type PresetKey } from "@/lib/authz/presets";
import type { Permission } from "@/lib/authz/types";

export type AgentFormPreset = PresetKey | "custom";

export interface AgentFormFieldsProps {
  name: string;
  onNameChange: (next: string) => void;

  preset: AgentFormPreset;
  permissions: Permission[];
  onPermissionsChange: (next: AgentPermissionPickerChange) => void;

  persona: string;
  onPersonaChange: (next: string) => void;

  nameInputId?: string;
  personaInputId?: string;
  readOnly?: boolean;
}

export function AgentFormFields({
  name,
  onNameChange,
  preset,
  permissions,
  onPermissionsChange,
  persona,
  onPersonaChange,
  nameInputId = "agent-form-name",
  personaInputId = "agent-form-persona",
  readOnly = false,
}: AgentFormFieldsProps) {
  const t = useTranslations();

  // The picker is displayed against the full effective permission set: for a
  // preset, show its built-in set; for custom mode, whatever is stored.
  const pickerPermissions: Permission[] = useMemo(() => {
    if (preset === "custom") return permissions;
    return [...ROLE_PRESETS[preset]];
  }, [preset, permissions]);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor={nameInputId} className="text-[13px]">
          {t("settings.name")}
        </Label>
        <Input
          id={nameInputId}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t("settings.namePlaceholder")}
          className="border-[#E5E0D8]"
          required
          disabled={readOnly}
        />
      </div>

      <AgentPermissionPicker
        preset={preset}
        permissions={pickerPermissions}
        onChange={onPermissionsChange}
        readOnly={readOnly}
      />

      <div className="space-y-2">
        <Label htmlFor={personaInputId} className="text-[13px]">
          {t("settings.agentPersona")}
        </Label>
        <Textarea
          id={personaInputId}
          value={persona}
          onChange={(e) => onPersonaChange(e.target.value)}
          placeholder={t("settings.personaPlaceholder")}
          rows={4}
          disabled={readOnly}
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.personaHint")}
        </p>
      </div>
    </div>
  );
}

export default AgentFormFields;
