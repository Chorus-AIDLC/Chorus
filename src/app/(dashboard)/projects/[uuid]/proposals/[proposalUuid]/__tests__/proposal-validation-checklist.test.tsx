// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../../../../../../messages/en.json";
import zh from "../../../../../../../../messages/zh.json";
import { ProposalValidationChecklist } from "../proposal-validation-checklist";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(Object.entries({ en, zh }))("%s validation checklist", (locale, messages) => {
  it("renders the localized cycle path even when the issue has no field", async () => {
    const cycle = "Parser -> Tests -> Parser";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { valid: false, issues: [{
        id: "E-DEP-CYCLE",
        level: "error",
        message: `Task drafts form a dependency cycle: ${cycle}`,
        params: { cycle },
      }] } }),
    }));
    const onError = vi.fn();
    render(
      <NextIntlClientProvider locale={locale} messages={messages} onError={onError}>
        <ProposalValidationChecklist projectUuid="project" proposalUuid="proposal" status="draft" />
      </NextIntlClientProvider>,
    );

    await screen.findByText(locale === "en" ? "1 error" : "1 个错误");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(messages.proposalValidation["E-DEP-CYCLE"].replace("{cycle}", cycle))).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });
});
