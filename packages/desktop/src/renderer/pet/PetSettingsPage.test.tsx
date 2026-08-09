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
});
