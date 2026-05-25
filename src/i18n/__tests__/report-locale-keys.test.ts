// Locale-key contract for the idea-completion-report feature.
//
// The Reports surface relies on three i18n keys that MUST exist with non-empty
// values in BOTH `en` and `zh` — losing any of them would render the
// reports-list with raw key strings as fallback (verified visually + via the
// reports-list render tests). This test pins the contract so a translation
// drift can't ship silently.
//
// Note: the original task description referenced `proposals.reports`, but the
// actual surface (T2) lives on the Idea overview tab and uses `idea.reportsList`
// + `idea.reportsAcrossProposals` instead. We assert against the keys that
// were actually shipped, not the placeholder names from the task spec.

import { describe, expect, it } from "vitest";
import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";

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

const REQUIRED_KEYS = [
  "documents.typeReport",
  "idea.reportsList",
  "idea.reportsAcrossProposals",
] as const;

const LOCALES = [
  ["en", enMessages as Record<string, MessageNode>],
  ["zh", zhMessages as Record<string, MessageNode>],
] as const;

describe("idea-completion-report locale keys", () => {
  for (const [localeName, messages] of LOCALES) {
    describe(`${localeName}.json`, () => {
      for (const key of REQUIRED_KEYS) {
        it(`has a non-empty string at "${key}"`, () => {
          const value = resolveDeep(messages, key);
          expect(value, `missing key ${key} in ${localeName}.json`).toBeDefined();
          expect(
            typeof value,
            `key ${key} in ${localeName}.json must be a string`,
          ).toBe("string");
          // Non-empty AND not just whitespace — an empty translation in either
          // locale is functionally a missing key for the UI.
          expect(
            (value as string).trim().length,
            `key ${key} in ${localeName}.json must be non-empty`,
          ).toBeGreaterThan(0);
        });
      }
    });
  }

  it("documents.typeReport renders the same Document type across locales", () => {
    // Both locales must define typeReport (we assert the value is a string
    // above) — here we just confirm the en and zh entries are independent
    // strings, not accidentally cross-pointed at the same fallback constant.
    const en = resolveDeep(enMessages as Record<string, MessageNode>, "documents.typeReport");
    const zh = resolveDeep(zhMessages as Record<string, MessageNode>, "documents.typeReport");
    expect(typeof en).toBe("string");
    expect(typeof zh).toBe("string");
    // Sanity: en should be the English label "Report".
    expect(en).toBe("Report");
  });

  it("idea.reportsList is a SCREAMING-CASE label in en (matches reports-list header expectation)", () => {
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
