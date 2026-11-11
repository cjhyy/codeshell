import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MimiPresenceSnapshot } from "../../shared/mimi-presence";
import { PetSettingsPage, type PetSettingsPageProps } from "./PetSettingsPage";
import type { MimiSettingsSection } from "./settings/mimiSettingsSections";

const presence: MimiPresenceSnapshot = {
  visible: true,
  mode: "docked",
  effectiveMode: "docked",
  size: 200,
  appearance: "shiro-sprite",
  shown: "docked",
  movingAvailable: true,
  previewing: false,
};

function render(section: MimiSettingsSection, props: Partial<PetSettingsPageProps> = {}) {
  return renderToStaticMarkup(
    <PetSettingsPage
      section={section}
      onSectionChange={() => undefined}
      backLabel="返回设置"
      onBack={() => undefined}
      activeModelKey="deepseek-v4-pro"
      modelOptions={[{ key: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "DeepSeek" }]}
      hasModelOverride
      onSelectModel={() => undefined}
      onResetModel={() => undefined}
      widgetVisible
      presence={presence}
      onWidgetVisibleChange={() => undefined}
      onPresenceChange={() => undefined}
      onOpenMemoryCenter={() => undefined}
      {...props}
    />,
  );
}

describe("PetSettingsPage", () => {
  test("lists every section in the left navigation and marks the open one", () => {
    const html = render("notifications");
    expect(html).toContain('data-pet-settings-page="standalone"');
    expect(html).toContain('aria-label="Mimi 设置分区"');
    for (const label of ["形象与显示", "对话", "通知与主动", "规则与跟进", "记忆", "消息连接"])
      expect(html).toContain(label);
    expect(html).toMatch(/aria-current="page"[^>]*data-pet-settings-nav-item="notifications"/);
    expect(html).toContain('data-pet-settings-section="notifications"');
    // The narrow layout's section picker and back button render beside the list.
    expect(html).toContain("data-pet-settings-section-picker");
    expect(html).toContain("返回设置");
    expect(html).toContain("@container/mimi-settings");
  });

  test("形象与显示 holds the one show switch and how Mimi looks", () => {
    const html = render("appearance", { presenceError: "display server unavailable" });
    expect(html).toContain('data-pet-setting="widget"');
    expect(html).toContain('data-state="checked"');
    expect(html).toContain("data-mimi-presence-controls");
    expect(html).toMatch(/aria-checked="true"[^>]*data-mimi-character="shiro-sprite"/);
    expect(html).toContain('data-mimi-mode="moving"');
    expect(html).toContain("data-mimi-presence-error");
    expect(html).toContain("设置没有生效：display server unavailable");
    expect(html).not.toContain('data-pet-setting="model"');
  });

  test("对话 holds the Mimi-only model and the personalization fields inline", () => {
    const html = render("conversation");
    expect(html).toContain('data-pet-setting="model"');
    expect(html).toContain('data-active-model="deepseek-v4-pro"');
    expect(html).toContain("长程工作 Session 继续使用自己的默认模型");
    expect(html).toContain('data-pet-setting="personalization"');
    expect(html).toContain("不会改变普通 Work Session");
    for (const id of [
      "pet-response-language",
      "pet-user-profile",
      "pet-communication-style",
      "pet-custom-instructions",
    ])
      expect(html).toContain(`id="${id}"`);
  });

  test("the remaining sections render their own content", () => {
    expect(render("notifications")).toContain('data-pet-setting="notifications"');
    expect(render("rules")).toContain('data-pet-setting="rules"');
    expect(render("memory")).toContain('data-pet-setting="memory"');
    const connections = render("connections");
    expect(connections).toContain("data-channel-page");
    expect(connections).toContain("CodeShell Chat Gateway");
  });

  test("shows an inherited external default and explains the explicit Mimi override", () => {
    const html = render("conversation", {
      activeModelKey: "codex/gpt-6.1-sol",
      modelOptions: [{ key: "codex/gpt-6.1-sol", label: "Codex · GPT-6.1 Sol", provider: "codex" }],
      hasModelOverride: false,
    });
    expect(html).toContain('data-active-model="codex/gpt-6.1-sol"');
    expect(html).toContain("Codex · GPT-6.1 Sol");
    expect(html).toContain("当前跟随应用默认模型");
    expect(html).toContain("单独选择会覆盖新会话默认模型");
    expect(html).toContain("Mimi 和微信沿用新会话默认模型");
  });
});
