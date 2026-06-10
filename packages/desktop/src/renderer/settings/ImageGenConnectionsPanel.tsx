import React from "react";
import { GenConnectionsPanel, type GenPanelConfig, type ProviderMeta } from "./GenConnectionsPanel";

const IMAGE_PROVIDERS: ProviderMeta[] = [
  {
    id: "openai",
    kind: "openai",
    displayName: "OpenAI Images (gpt-image)",
    description: "OpenAI 图像 API。需要 OpenAI key；baseUrl 默认官方端点。",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-image-2",
    signupUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    kind: "google",
    displayName: "Gemini Images (Nano Banana)",
    description:
      "Gemini 图像生成。可直接用你已有的 Google key；OpenAI 兼容 baseUrl（/v1beta/openai）也会被自动规范到原生端点。",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash-image",
    signupUrl: "https://aistudio.google.com/apikey",
  },
];

const IMAGE_CONFIG: GenPanelConfig = {
  settingsKey: "imageGen",
  providers: IMAGE_PROVIDERS,
  showTest: true,
  testFn: (input) => window.codeshell.probeImage(input),
  labels: {
    testIdle: "测试生图",
    testBusy: "生成中…",
    testTitleConfigured: "用当前配置真生成一张测试图",
    keyHint: "保存于 ~/.code-shell/settings.json，按 scope 隔离。",
  },
};

export function ImageGenConnectionsPanel({ scope, activeRepoPath }: { scope: "user" | "project"; activeRepoPath: string | null }) {
  return <GenConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} config={IMAGE_CONFIG} />;
}
