import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import ko from "../../../messages/ko.json";
import ja from "../../../messages/ja.json";

describe.each(Object.entries({ en, zh, ko, ja }))("%s proposal validation messages", (locale, messages) => {
  it("renders dependency and kind issues with their context", () => {
    const errors: Error[] = [];
    const t = createTranslator({ locale, messages, namespace: "proposalValidation", onError: (error) => errors.push(error) });
    const issues = [
      { id: "E-DEP-UNKNOWN", values: { title: "Parser" } },
      { id: "E-DEP-SELF", values: { title: "Parser" } },
      { id: "E-DEP-CYCLE", values: { cycle: "Parser -> Tests -> Parser" } },
      { id: "W-IMPL", values: {} },
      { id: "I-KIND", values: {} },
    ] as const;
    for (const issue of issues) {
      const text = t(issue.id, issue.values);
      expect(text).not.toContain(`proposalValidation.${issue.id}`);
      for (const value of Object.values(issue.values ?? {})) expect(text).toContain(value);
    }
    expect(errors).toEqual([]);
  });
});
