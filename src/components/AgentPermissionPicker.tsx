"use client";

import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_PRESETS, type PresetKey } from "@/lib/authz/presets";
import {
  ACTIONS,
  RESOURCES,
  type Action,
  type Permission,
  type Resource,
} from "@/lib/authz/types";

const PRESET_LABEL_KEY: Record<PresetKey | "custom", string> = {
  admin_agent: "agent.permissions.presetAdmin",
  pm_agent: "agent.permissions.presetPm",
  developer_agent: "agent.permissions.presetDev",
  custom: "agent.permissions.presetCustom",
};

const PRESET_HELP_KEY: Record<PresetKey | "custom", string> = {
  admin_agent: "agent.permissions.help.admin",
  pm_agent: "agent.permissions.help.pm",
  developer_agent: "agent.permissions.help.dev",
  custom: "agent.permissions.help.custom",
};

const PRESET_CHOICES: readonly (PresetKey | "custom")[] = [
  "admin_agent",
  "pm_agent",
  "developer_agent",
  "custom",
];

type SelectedPreset = PresetKey | "custom";

export interface AgentPermissionPickerChange {
  preset: SelectedPreset;
  roles: string[];
  permissions: string[];
}

export interface AgentPermissionPickerProps {
  preset: PresetKey | "custom" | null;
  permissions: Permission[];
  onChange: (next: AgentPermissionPickerChange) => void;
  readOnly?: boolean;
}

function perm(resource: Resource, action: Action): Permission {
  return `${resource}:${action}` as Permission;
}

export function AgentPermissionPicker({
  preset,
  permissions,
  onChange,
  readOnly = false,
}: AgentPermissionPickerProps) {
  const t = useTranslations();

  const selectedPreset: SelectedPreset = preset ?? "custom";
  // When a role preset is active, the checked state reflects that preset's
  // permission set so users see the effect of their choice. In custom mode
  // the checked state is the raw `permissions` prop.
  const checked =
    selectedPreset === "custom"
      ? new Set<Permission>(permissions)
      : new Set<Permission>(ROLE_PRESETS[selectedPreset]);

  function handlePresetChange(value: string) {
    if (value === "custom") {
      onChange({
        preset: "custom",
        roles: [],
        permissions: Array.from(checked),
      });
      return;
    }
    const key = value as PresetKey;
    if (!(key in ROLE_PRESETS)) return;
    onChange({
      preset: key,
      roles: [key],
      permissions: [],
    });
  }

  function handleToggle(p: Permission, next: boolean) {
    const nextSet = new Set(checked);
    if (next) nextSet.add(p);
    else nextSet.delete(p);
    onChange({
      preset: "custom",
      roles: [],
      permissions: Array.from(nextSet),
    });
  }

  return (
    <div data-testid="agent-permission-picker" className="space-y-4">
      <div className="space-y-1">
        <Label className="text-[13px] font-medium">
          {t("agent.permissions.title")}
        </Label>
        <p className="text-muted-foreground text-xs">
          {t("agent.permissions.description")}
        </p>
      </div>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="agent-permission-preset">
            {t("agent.permissions.presetLabel")}
          </Label>
          <Select
            value={selectedPreset}
            onValueChange={handlePresetChange}
            disabled={readOnly}
          >
            <SelectTrigger
              id="agent-permission-preset"
              className="w-full"
              aria-label={t("agent.permissions.presetLabel")}
            >
              <SelectValue placeholder={t(PRESET_LABEL_KEY[selectedPreset])}>
                {t(PRESET_LABEL_KEY[selectedPreset])}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PRESET_CHOICES.map((key) => (
                <SelectItem
                  key={key}
                  value={key}
                  textValue={t(PRESET_LABEL_KEY[key])}
                >
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="text-sm font-semibold">
                      {t(PRESET_LABEL_KEY[key])}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t(PRESET_HELP_KEY[key])}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div
          role="grid"
          aria-label={t("agent.permissions.title")}
          className="overflow-hidden rounded-md border"
        >
          <div
            role="row"
            className="bg-muted/50 text-muted-foreground grid grid-cols-[1.5fr_repeat(3,1fr)] items-center gap-2 px-4 py-2 text-xs font-medium"
          >
            <div role="columnheader">{t("agent.permissions.resourceHeader")}</div>
            {ACTIONS.map((action) => (
              <div
                key={action}
                role="columnheader"
                className="text-center"
              >
                {t(`agent.permissions.actions.${action}`)}
              </div>
            ))}
          </div>
          {RESOURCES.map((resource) => (
            <div
              key={resource}
              role="row"
              className="border-t grid grid-cols-[1.5fr_repeat(3,1fr)] items-center gap-2 px-4 py-2 text-sm"
            >
              <div role="rowheader" className="font-medium">
                {t(`agent.permissions.resources.${resource}`)}
              </div>
              {ACTIONS.map((action) => {
                const p = perm(resource, action);
                const inputId = `perm-${resource}-${action}`;
                const disabled = readOnly;
                return (
                  <div
                    key={action}
                    role="gridcell"
                    className="flex items-center justify-center"
                  >
                    <Checkbox
                      id={inputId}
                      checked={checked.has(p)}
                      disabled={disabled}
                      aria-label={`${t(
                        `agent.permissions.resources.${resource}`,
                      )} ${t(`agent.permissions.actions.${action}`)}`}
                      onCheckedChange={(v) => {
                        if (disabled) return;
                        handleToggle(p, v === true);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default AgentPermissionPicker;
