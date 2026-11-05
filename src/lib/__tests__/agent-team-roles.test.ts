import { describe, expect, it } from "vitest";
import { AGENT_TEAM_ROLES, AGENT_TEAM_ROLE_DEFINITIONS, getAgentTeamRoleEligibility } from "../agent-team-roles";
import { computeEffectivePermissions } from "../authz/permissions";
import type { Permission } from "../authz/types";

const reads: Permission[] = ["idea:read", "proposal:read", "document:read", "task:read", "project:read"];
const additions = {
  product: ["idea:write", "proposal:write", "document:write"],
  development: ["task:write"],
  review: [],
  lead: ["idea:write", "idea:admin", "proposal:write", "proposal:admin", "task:write", "task:admin", "document:write"],
};

describe("agent team role contract", () => {
  it("exports exactly the four stable role IDs", () => {
    expect(AGENT_TEAM_ROLES).toEqual(["product", "development", "review", "lead"]);
  });

  it.each(AGENT_TEAM_ROLES)("requires the exact %s matrix and reports each missing bit", (role) => {
    const required = [...reads, ...additions[role]];
    expect(AGENT_TEAM_ROLE_DEFINITIONS[role].requiredPermissions).toEqual(required);
    expect(getAgentTeamRoleEligibility(role, required)).toEqual({ eligible: true, missingPermissions: [] });
    for (const permission of required) {
      expect(getAgentTeamRoleEligibility(role, required.filter((bit) => bit !== permission)))
        .toEqual({ eligible: false, missingPermissions: [permission] });
    }
    expect(getAgentTeamRoleEligibility(role, [])).toEqual({ eligible: false, missingPermissions: required });
  });

  it("uses preset unions with custom bits without modifying the permission set", () => {
    const permissions = computeEffectivePermissions(["pm"], ["idea:admin", "proposal:admin", "task:admin"]);
    const before = [...permissions];
    expect(getAgentTeamRoleEligibility("lead", permissions).eligible).toBe(true);
    expect([...permissions]).toEqual(before);
    expect(getAgentTeamRoleEligibility("product", computeEffectivePermissions(["pm_agent"], [])).eligible).toBe(true);
    expect(getAgentTeamRoleEligibility("development", computeEffectivePermissions(["developer"], [])).eligible).toBe(true);
    expect(getAgentTeamRoleEligibility("lead", computeEffectivePermissions(["admin_agent"], [])).eligible).toBe(true);
  });

  it("does not infer read/write authority from admin bits or project access", () => {
    const permissions = computeEffectivePermissions([], ["idea:admin", "proposal:admin", "task:admin", "document:admin", "project:admin"]);
    expect(getAgentTeamRoleEligibility("review", permissions)).toEqual({ eligible: false, missingPermissions: reads });
    expect(getAgentTeamRoleEligibility("review", reads).eligible).toBe(true);
    expect(getAgentTeamRoleEligibility("lead", computeEffectivePermissions(["pm"], [])).missingPermissions)
      .toEqual(["idea:admin", "proposal:admin", "task:admin"]);
  });
});
