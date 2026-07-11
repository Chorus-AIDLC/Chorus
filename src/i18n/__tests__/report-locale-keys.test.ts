// Value-specific i18n contracts for the idea-completion-report surface.
//
// Key EXISTENCE + non-empty + ICU-argument parity across all locales is now
// enforced generally by locale-parity.test.ts — this file no longer duplicates
// that. What remains here are the VALUE-specific assertions that the parity
// guard can't express: specific en label strings the reports-list render tests
// depend on. Losing these would break the UI tests, so they stay pinned at the
// locale layer.

import { describe, expect, it } from "vitest";
import enMessages from "../../../messages/en.json";

type MessageNode = string | { [key: string]: MessageNode };

function resolveDeep(messages: Record<string, MessageNode>, path: string): unknown {
  let node: unknown = messages;
  for (const segment of path.split(".")) {
    if (
      node &&
      typeof node === "object" &&
      segment in (node as Record<string, unknown>)
    ) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

describe("idea-completion-report locale values", () => {
  it("documents.typeReport is the English label 'Report'", () => {
    const en = resolveDeep(enMessages as Record<string, MessageNode>, "documents.typeReport");
    expect(en).toBe("Report");
  });

  it("idea.reportsList is the SCREAMING-CASE header 'REPORTS'", () => {
    // The reports-list render test asserts the header text is "REPORTS" — this
    // pins that contract at the locale layer so a future translation edit
    // can't quietly break the UI test by lowercasing the label.
    const value = resolveDeep(
      enMessages as Record<string, MessageNode>,
      "idea.reportsList",
    );
    expect(value).toBe("REPORTS");
  });
});
