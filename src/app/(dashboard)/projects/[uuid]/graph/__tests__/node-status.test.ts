// src/app/(dashboard)/projects/[uuid]/graph/__tests__/node-status.test.ts
//
// Unit tests for the shared resource-graph status presentation module.
//
// The module is the single source of truth for both the canvas painter (which
// needs raw hex) and the DOM badge (which uses Tailwind `bg-[#..] text-[#..]`).
// The key invariant is canvas↔DOM color parity: for every known status value,
// the `bg`/`fg` hex pair MUST equal the hex inside its Tailwind `colorClass`.
// A divergence between those two would manifest as two different colors for
// the same status — one in the canvas pill and one in the outline badge.
//
// We also pin: (a) every concrete status has a defined i18n labelKey;
// (b) an unknown / sentinel value resolves to UNKNOWN_FALLBACK (no crash, no
// dangling labelKey).

import { describe, it, expect } from "vitest";
import {
  KNOWN_STATUS_VALUES,
  PROPOSAL_STATUS_COLOR,
  STATUS_UNKNOWN_SENTINEL,
  TASK_STATUS_COLOR,
  UNKNOWN_FALLBACK,
  resolveNodeStatusVisual,
} from "../node-status";
import type { ResourceGraphNodeType } from "@/services/resource-graph.service";

// Parse a Tailwind arbitrary-color class string into its bg/fg hex pair.
function parseColorClass(colorClass: string): { bg: string; fg: string } {
  const bg = colorClass.match(/bg-\[(#[0-9A-Fa-f]+)\]/)?.[1] ?? "";
  const fg = colorClass.match(/text-\[(#[0-9A-Fa-f]+)\]/)?.[1] ?? "";
  return { bg, fg };
}

const TYPES: ResourceGraphNodeType[] = ["idea", "proposal", "task", "document"];

describe("resolveNodeStatusVisual — canvas↔DOM color parity", () => {
  it("returns a complete { labelKey, colorClass, bg, fg } record for every known status", () => {
    for (const type of TYPES) {
      for (const value of KNOWN_STATUS_VALUES[type]) {
        const visual = resolveNodeStatusVisual(type, value);
        expect(visual.labelKey, `${type}/${value}: labelKey`).toMatch(/\w+\.\w+/);
        expect(visual.colorClass, `${type}/${value}: colorClass`).toMatch(/bg-\[#/);
        expect(visual.colorClass, `${type}/${value}: colorClass`).toMatch(/text-\[#/);
        expect(visual.bg, `${type}/${value}: bg`).toMatch(/^#[0-9A-Fa-f]+$/);
        expect(visual.fg, `${type}/${value}: fg`).toMatch(/^#[0-9A-Fa-f]+$/);
      }
    }
  });

  it("for every status, the bg/fg hex pair equals the hex INSIDE the Tailwind colorClass", () => {
    // This is the load-bearing invariant — if it ever fails, the canvas pill
    // and the DOM badge would render in different colors for the same value.
    for (const type of TYPES) {
      for (const value of KNOWN_STATUS_VALUES[type]) {
        const visual = resolveNodeStatusVisual(type, value);
        const parsed = parseColorClass(visual.colorClass);
        expect(parsed.bg.toLowerCase(), `${type}/${value}: bg hex`).toBe(
          visual.bg.toLowerCase(),
        );
        expect(parsed.fg.toLowerCase(), `${type}/${value}: fg hex`).toBe(
          visual.fg.toLowerCase(),
        );
      }
    }
  });
});

describe("resolveNodeStatusVisual — label namespaces (no new i18n key roots)", () => {
  it("idea hints resolve under `ideaTracker.badge.*`", () => {
    for (const value of KNOWN_STATUS_VALUES.idea) {
      expect(resolveNodeStatusVisual("idea", value).labelKey).toMatch(
        /^ideaTracker\.badge\./,
      );
    }
  });

  it("proposal / task lifecycle resolves under `status.*`", () => {
    for (const value of KNOWN_STATUS_VALUES.proposal) {
      expect(resolveNodeStatusVisual("proposal", value).labelKey).toMatch(/^status\./);
    }
    for (const value of KNOWN_STATUS_VALUES.task) {
      expect(resolveNodeStatusVisual("task", value).labelKey).toMatch(/^status\./);
    }
  });

  it("document type resolves under `documents.type*`", () => {
    for (const value of KNOWN_STATUS_VALUES.document) {
      expect(resolveNodeStatusVisual("document", value).labelKey).toMatch(
        /^documents\.type/,
      );
    }
  });
});

describe("resolveNodeStatusVisual — fallback / sentinel", () => {
  it("the sentinel value resolves to the defined fallback (no crash, no undefined labelKey)", () => {
    const visual = resolveNodeStatusVisual("idea", STATUS_UNKNOWN_SENTINEL);
    expect(visual).toEqual(UNKNOWN_FALLBACK);
  });

  it("an empty status string resolves to the fallback", () => {
    const visual = resolveNodeStatusVisual("task", "");
    expect(visual).toEqual(UNKNOWN_FALLBACK);
  });

  it("an unmapped status value (per type) resolves to the fallback for every node type", () => {
    for (const type of TYPES) {
      const visual = resolveNodeStatusVisual(type, "definitely_not_a_real_value_xyz");
      expect(visual).toEqual(UNKNOWN_FALLBACK);
    }
  });

  it("the fallback's bg/fg hex equals the hex in its colorClass", () => {
    const parsed = parseColorClass(UNKNOWN_FALLBACK.colorClass);
    expect(parsed.bg.toLowerCase()).toBe(UNKNOWN_FALLBACK.bg.toLowerCase());
    expect(parsed.fg.toLowerCase()).toBe(UNKNOWN_FALLBACK.fg.toLowerCase());
  });
});

describe("resolveNodeStatusVisual — exported maps match resolver output", () => {
  // The lifted PROPOSAL_STATUS_COLOR / TASK_STATUS_COLOR maps are re-exported
  // so node-tooltip.tsx (T1's shim) can keep using them verbatim. The
  // resolver MUST return the same colorClass strings.
  it("proposal: resolver.colorClass equals PROPOSAL_STATUS_COLOR[value]", () => {
    for (const [value, colorClass] of Object.entries(PROPOSAL_STATUS_COLOR)) {
      expect(resolveNodeStatusVisual("proposal", value).colorClass).toBe(colorClass);
    }
  });

  it("task: resolver.colorClass equals TASK_STATUS_COLOR[value]", () => {
    for (const [value, colorClass] of Object.entries(TASK_STATUS_COLOR)) {
      expect(resolveNodeStatusVisual("task", value).colorClass).toBe(colorClass);
    }
  });
});
