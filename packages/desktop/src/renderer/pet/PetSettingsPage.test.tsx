import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetSettingsPage } from "./PetSettingsPage";

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
        onOpenConnections={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(html).toContain('data-pet-settings-page="standalone"');
    expect(html).toContain('data-pet-setting="model"');
    expect(html).toContain('data-active-model="deepseek-v4-pro"');
    expect(html).toContain("长程工作 Session 继续使用自己的默认模型");
    expect(html).toContain('data-pet-setting="widget"');
    expect(html).toContain('data-state="checked"');
    expect(html).toContain('data-pet-setting="connections"');
  });
});
