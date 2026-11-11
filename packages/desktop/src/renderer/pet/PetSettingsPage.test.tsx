import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetPersonalizationPage, PetSettingsPage } from "./PetSettingsPage";

describe("PetSettingsPage", () => {
  test("keeps Mimi-specific controls on a standalone settings page", () => {
    const html = renderToStaticMarkup(
      <PetSettingsPage
        activeModelKey="deepseek-v4-pro"
        modelOptions={[{ key: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "DeepSeek" }]}
        hasModelOverride
        widgetVisible
        onSelectModel={() => undefined}
        onResetModel={() => undefined}
        onWidgetVisibleChange={() => undefined}
        onOpenPersonalization={() => undefined}
        onOpenConnections={() => undefined}
        onOpenMemory={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(html).toContain('data-pet-settings-page="standalone"');
    expect(html).toContain('data-pet-setting="personalization"');
    expect(html).toContain("Mimi 个性化");
    expect(html).toContain("不会改变普通 Work Session");
    expect(html).toContain("设置个性化");
    expect(html).not.toContain('id="pet-response-language"');
    expect(html).not.toContain('id="pet-user-profile"');
    expect(html).not.toContain('id="pet-communication-style"');
    expect(html).not.toContain('id="pet-custom-instructions"');
    expect(html).toContain('data-pet-setting="model"');
    expect(html).toContain('data-pet-setting="memory"');
    expect(html).toContain('data-active-model="deepseek-v4-pro"');
    expect(html).toContain("长程工作 Session 继续使用自己的默认模型");
    expect(html).toContain('data-pet-setting="widget"');
    expect(html).toContain('data-state="checked"');
    expect(html).toContain('data-pet-setting="connections"');
    expect(html).toContain('data-pet-setting="notifications"');
    expect(html).toContain("通知与主动");
  });

  test("moves personalization fields into a dedicated second-level page", () => {
    const html = renderToStaticMarkup(<PetPersonalizationPage onBack={() => undefined} />);

    expect(html).toContain('data-pet-personalization-page="standalone"');
    expect(html).toContain('data-pet-personalization-fields="true"');
    expect(html).toContain("返回 Mimi 设置");
    expect(html).toContain('id="pet-response-language"');
    expect(html).toContain('id="pet-user-profile"');
    expect(html).toContain('id="pet-communication-style"');
    expect(html).toContain('id="pet-custom-instructions"');
  });

  test("shows an inherited external default and explains the explicit Mimi override", () => {
    const html = renderToStaticMarkup(
      <PetSettingsPage
        activeModelKey="codex/gpt-6.1-sol"
        modelOptions={[
          { key: "codex/gpt-6.1-sol", label: "Codex · GPT-6.1 Sol", provider: "codex" },
        ]}
        hasModelOverride={false}
        widgetVisible
        onSelectModel={() => undefined}
        onResetModel={() => undefined}
        onWidgetVisibleChange={() => undefined}
        onOpenPersonalization={() => undefined}
        onOpenConnections={() => undefined}
        onOpenMemory={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(html).toContain('data-active-model="codex/gpt-6.1-sol"');
    expect(html).toContain("Codex · GPT-6.1 Sol");
    expect(html).toContain("当前跟随应用默认模型");
    expect(html).toContain("单独选择会覆盖新会话默认模型");
    expect(html).toContain("Mimi 和微信沿用新会话默认模型");
  });
});
