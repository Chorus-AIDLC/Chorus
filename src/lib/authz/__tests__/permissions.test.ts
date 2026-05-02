import { describe, it, expect } from "vitest";
import {
  computeEffectivePermissions,
  isValidPermission,
} from "../permissions";
import { ROLE_PRESETS } from "../presets";
import { ALL_PERMISSIONS, type Permission } from "../types";

describe("ALL_PERMISSIONS", () => {
  it("contains exactly 15 entries", () => {
    expect(ALL_PERMISSIONS).toHaveLength(15);
  });

  it("contains every resource × action combination", () => {
    const expected = new Set<string>();
    for (const r of ["idea", "proposal", "document", "task", "project"]) {
      for (const a of ["read", "write", "admin"]) {
        expected.add(`${r}:${a}`);
      }
    }
    expect(new Set(ALL_PERMISSIONS)).toEqual(expected);
  });
});

describe("ROLE_PRESETS", () => {
  it("developer_agent has 6 permissions", () => {
    expect(ROLE_PRESETS.developer_agent).toHaveLength(6);
    expect(new Set(ROLE_PRESETS.developer_agent)).toEqual(
      new Set<Permission>([
        "idea:read",
        "proposal:read",
        "document:read",
        "project:read",
        "task:read",
        "task:write",
      ]),
    );
  });

  it("pm_agent has 10 permissions", () => {
    expect(ROLE_PRESETS.pm_agent).toHaveLength(10);
    expect(new Set(ROLE_PRESETS.pm_agent)).toEqual(
      new Set<Permission>([
        "idea:read",
        "idea:write",
        "proposal:read",
        "proposal:write",
        "document:read",
        "document:write",
        "task:read",
        "task:write",
        "project:read",
        "project:write",
      ]),
    );
  });

  it("admin_agent has all 15 permissions", () => {
    expect(ROLE_PRESETS.admin_agent).toHaveLength(15);
    expect(new Set(ROLE_PRESETS.admin_agent)).toEqual(new Set(ALL_PERMISSIONS));
  });
});

describe("computeEffectivePermissions", () => {
  it("returns pm_agent preset for ['pm_agent']", () => {
    const result = computeEffectivePermissions(["pm_agent"], []);
    expect(result).toEqual(new Set(ROLE_PRESETS.pm_agent));
  });

  it("returns developer_agent preset for ['developer_agent']", () => {
    const result = computeEffectivePermissions(["developer_agent"], []);
    expect(result).toEqual(new Set(ROLE_PRESETS.developer_agent));
  });

  it("returns admin_agent preset for ['admin_agent']", () => {
    const result = computeEffectivePermissions(["admin_agent"], []);
    expect(result).toEqual(new Set(ROLE_PRESETS.admin_agent));
  });

  it("treats 'pm' as 'pm_agent' (backward-compat short form)", () => {
    const short = computeEffectivePermissions(["pm"], []);
    const long = computeEffectivePermissions(["pm_agent"], []);
    expect(short).toEqual(long);
  });

  it("treats 'developer' as 'developer_agent' (backward-compat short form)", () => {
    const short = computeEffectivePermissions(["developer"], []);
    const long = computeEffectivePermissions(["developer_agent"], []);
    expect(short).toEqual(long);
  });

  it("treats 'admin' as 'admin_agent' (backward-compat short form)", () => {
    const short = computeEffectivePermissions(["admin"], []);
    const long = computeEffectivePermissions(["admin_agent"], []);
    expect(short).toEqual(long);
  });

  it("returns empty set for empty roles and empty custom", () => {
    const result = computeEffectivePermissions([], []);
    expect(result.size).toBe(0);
  });

  it("returns only custom permissions when roles are empty", () => {
    const result = computeEffectivePermissions([], ["proposal:admin"]);
    expect(result).toEqual(new Set<Permission>(["proposal:admin"]));
  });

  it("returns union of role preset and custom permissions", () => {
    const result = computeEffectivePermissions(
      ["developer_agent"],
      ["proposal:write"],
    );
    expect(result.size).toBe(7);
    expect(result).toEqual(
      new Set<Permission>([
        "idea:read",
        "proposal:read",
        "document:read",
        "project:read",
        "task:read",
        "task:write",
        "proposal:write",
      ]),
    );
  });

  it("deduplicates when custom permission overlaps preset", () => {
    const result = computeEffectivePermissions(
      ["developer_agent"],
      ["task:read", "task:write"],
    );
    expect(result.size).toBe(6);
    expect(result).toEqual(new Set(ROLE_PRESETS.developer_agent));
  });

  it("ignores invalid permission strings in custom input", () => {
    const result = computeEffectivePermissions([], ["foo:bar", "task:read"]);
    expect(result).toEqual(new Set<Permission>(["task:read"]));
  });

  it("ignores unknown role names", () => {
    const result = computeEffectivePermissions(["unknown_agent"], []);
    expect(result.size).toBe(0);
  });

  it("merges multiple roles", () => {
    const result = computeEffectivePermissions(
      ["developer_agent", "pm_agent"],
      [],
    );
    expect(result).toEqual(new Set(ROLE_PRESETS.pm_agent));
  });
});

describe("isValidPermission", () => {
  it("returns true for valid permission strings", () => {
    expect(isValidPermission("task:admin")).toBe(true);
    expect(isValidPermission("idea:read")).toBe(true);
    expect(isValidPermission("project:write")).toBe(true);
  });

  it("returns false for invalid permission strings", () => {
    expect(isValidPermission("foo:bar")).toBe(false);
    expect(isValidPermission("task:")).toBe(false);
    expect(isValidPermission(":read")).toBe(false);
    expect(isValidPermission("task")).toBe(false);
    expect(isValidPermission("")).toBe(false);
    expect(isValidPermission("TASK:READ")).toBe(false);
  });
});
