// Locale-key parity guard.
//
// CLAUDE.md's i18n rule is absolute: every user-facing string must exist in
// EVERY locale. There are no legitimate single-locale keys — so the locale
// files must expose an identical key set, with matching ICU arguments, and no
// empty values. This test pins that invariant so a future feature that adds a
// key to en/ (or zh) but forgets ko can't merge silently. It generalizes the
// older, narrow report-locale-keys.test.ts (which only pinned 3 keys) to the
// whole corpus, driven by the `locales` array so a 4th locale is covered for
// free the moment it's registered.
//
// Why the ICU argument check parses the AST instead of a brace regex:
// a message like en `proposalValidation.errorCount` =
//   "{count} {count, plural, one {error} other {errors}}"
// has exactly ONE argument (`count`), but its plural sub-messages contain the
// literal words "error"/"errors". A brace regex (`/\{(\w+)\}/g` or
// `/\{\s*(\w+)\s*[,}]/g`) can't tell an argument name from sub-message text —
// it over- or under-extracts, and would falsely fail parity against a locale
// that correctly flattens the plural (Korean/Chinese have no grammatical
// plural, so `references.countLabel` becomes a single "{count}" phrase). Only
// parsing the ICU AST and collecting element argument names is correct; it
// yields the same argument set for the en plural block and the flattened
// locale value. @formatjs/icu-messageformat-parser is next-intl's own parser.

import { describe, expect, it } from "vitest";
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { locales, defaultLocale, type Locale } from "../config";

import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import ko from "../../../messages/ko.json";

type MessageNode = string | { [key: string]: MessageNode };
type Messages = Record<string, MessageNode>;

// Locale JSON is loaded here and keyed by locale code. If a new locale is added
// to `locales` in config.ts without a matching import + entry, the guard below
// fails loudly rather than silently skipping the new locale.
const MESSAGES: Record<string, Messages> = {
  en: en as Messages,
  zh: zh as Messages,
  ko: ko as Messages,
};

const REFERENCE: Locale = defaultLocale; // en

/** Flatten a nested message object to a dotted-key -> string map. */
function flatten(node: MessageNode, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (node !== null && typeof node === "object") {
    for (const key of Object.keys(node)) {
      flatten(node[key], prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out[prefix] = node as string;
  }
  return out;
}

/**
 * Collect the set of named ICU arguments in a message by walking its AST.
 * Includes simple placeholders, number/date/time args, and plural/select
 * argument names; recurses into plural/select option sub-messages and tag
 * children. Excludes ICU keywords, category selectors, the `#` pound marker,
 * and all literal sub-message text.
 */
function namedArgs(message: string): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: MessageFormatElement[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case TYPE.argument:
        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
          out.add(node.value);
          break;
        case TYPE.plural:
        case TYPE.select:
          out.add(node.value);
          for (const opt of Object.values(node.options)) walk(opt.value);
          break;
        case TYPE.tag:
          walk(node.children);
          break;
        // literal, pound (#) -> no argument
        default:
          break;
      }
    }
  };
  walk(parse(message));
  return out;
}

const flat: Record<string, Record<string, string>> = {};
for (const loc of locales) {
  const messages = MESSAGES[loc];
  if (!messages) {
    throw new Error(
      `locale "${loc}" is registered in src/i18n/config.ts but has no messages import in locale-parity.test.ts — add it.`,
    );
  }
  flat[loc] = flatten(messages);
}

const refKeys = Object.keys(flat[REFERENCE]).sort();
const nonReferenceLocales = locales.filter((l) => l !== REFERENCE);

describe("locale key parity", () => {
  it(`every registered locale is importable (${locales.join(", ")})`, () => {
    for (const loc of locales) expect(flat[loc], `messages for ${loc}`).toBeDefined();
  });

  describe.each(nonReferenceLocales)("%s.json vs en.json", (loc) => {
    const locKeys = new Set(Object.keys(flat[loc]));
    const refKeySet = new Set(refKeys);

    it("has no keys missing relative to en", () => {
      const missing = refKeys.filter((k) => !locKeys.has(k));
      expect(missing, `${loc}.json is missing keys present in en.json:\n${missing.join("\n")}`).toEqual([]);
    });

    it("has no orphan keys absent from en", () => {
      const extra = [...locKeys].filter((k) => !refKeySet.has(k)).sort();
      expect(extra, `${loc}.json has keys not present in en.json:\n${extra.join("\n")}`).toEqual([]);
    });
  });

  describe.each(locales)("%s.json values", (loc) => {
    it("are all non-empty strings", () => {
      const bad = Object.entries(flat[loc])
        .filter(([, v]) => typeof v !== "string" || v.trim().length === 0)
        .map(([k]) => k);
      expect(bad, `${loc}.json has empty/non-string values at:\n${bad.join("\n")}`).toEqual([]);
    });
  });

  describe.each(nonReferenceLocales)("%s.json ICU arguments", (loc) => {
    it("match en's named-argument set per key", () => {
      const mismatches: string[] = [];
      for (const key of refKeys) {
        const refVal = flat[REFERENCE][key];
        const locVal = flat[loc][key];
        if (typeof refVal !== "string" || typeof locVal !== "string") continue; // key-set test covers this
        const refArgs = [...namedArgs(refVal)].sort();
        const locArgs = [...namedArgs(locVal)].sort();
        if (refArgs.join(",") !== locArgs.join(",")) {
          mismatches.push(`${key}: en={${refArgs.join(",")}} ${loc}={${locArgs.join(",")}}`);
        }
      }
      expect(mismatches, `ICU argument drift in ${loc}.json:\n${mismatches.join("\n")}`).toEqual([]);
    });
  });

  it("every locale value is a parseable ICU message", () => {
    // A malformed ICU string (e.g. an unbalanced brace introduced by a bad
    // translation) is a real runtime bug — next-intl would throw at format
    // time. Surface it here instead.
    const errors: string[] = [];
    for (const loc of locales) {
      for (const [key, value] of Object.entries(flat[loc])) {
        if (typeof value !== "string") continue;
        try {
          parse(value);
        } catch (e) {
          errors.push(`${loc}.${key}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
    expect(errors, `unparseable ICU messages:\n${errors.join("\n")}`).toEqual([]);
  });
});
