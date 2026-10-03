// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import ja from "../../../messages/ja.json";
import ko from "../../../messages/ko.json";
import { GroupActivityLabel } from "../group-activity-label";

afterEach(cleanup);

function label(locale: string, messages: typeof en, targetType: string, action: string) {
  return render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
    <span data-testid="activity"><GroupActivityLabel targetType={targetType} action={action} /></span>
  </NextIntlClientProvider>);
}

describe("localized group activity", () => {
  it.each([
    ["en", en, "Project member added"],
    ["zh", zh, "已添加项目成员"],
    ["ja", ja, "プロジェクトメンバーを追加"],
    ["ko", ko, "프로젝트 구성원 추가됨"],
  ] as const)("renders a human membership label in %s", (locale, messages, expected) => {
    label(locale, messages, "project", "project_member_added");
    expect(screen.getByTestId("activity")).toHaveTextContent(expected);
    expect(screen.getByTestId("activity")).not.toHaveTextContent("project_member_added");
  });

  it.each([
    ["group_access_initialized", "Group access initialized"],
    ["group_member_changed", "Group member access changed"],
    ["group_member_removed", "Group member removed"],
    ["group_updated", "Group settings or visibility updated"],
    ["project_group_changed", "Project moved between groups"],
    ["project_visibility_changed", "Project visibility changed"],
  ])("renders the %s audit action", (action, expected) => {
    label("en", en, "project_group", action);
    expect(screen.getByTestId("activity")).toHaveTextContent(expected);
  });

  it("localizes entity names and falls back without exposing unknown machine keys", () => {
    label("ja", ja, "task", "future_machine_key");
    expect(screen.getByTestId("activity")).toHaveTextContent("タスクを更新");
    expect(screen.getByTestId("activity")).not.toHaveTextContent("future_machine_key");
  });
});
