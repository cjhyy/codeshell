import React from "react";
import { GenConnectionsPanel, type GenPanelConfig, type ProviderMeta } from "./GenConnectionsPanel";

const VIDEO_PROVIDERS: ProviderMeta[] = [
  {
    id: "fal",
    kind: "fal",
    displayName: "fal.ai (Kling 等)",
    description:
      "通过 fal.ai 统一 API 调用 Kling/字节等视频模型。需要 fal key；模型 id 决定底层模型与文生/图生。",
    defaultBaseUrl: "https://queue.fal.run",
    defaultModel: "fal-ai/kling-video/v3/pro/text-to-video",
    signupUrl: "https://fal.ai/dashboard/keys",
  },
  {
    id: "jimeng",
    kind: "jimeng",
    displayName: "即梦 / 火山引擎",
    description: "即梦同源视频模型。",
    defaultBaseUrl: "",
    defaultModel: "",
    disabled: true,
    comingSoonNote:
      "即将支持。core 已预留 videoGen schema 与 submit/poll/download 接口,待接入火山引擎 AK/SK 签名适配器后开放。",
  },
];

const VIDEO_CONFIG: GenPanelConfig = {
  settingsKey: "videoGen",
  providers: VIDEO_PROVIDERS,
  showTest: false,
  labels: {
    testIdle: "",
    testBusy: "",
    testTitleConfigured: "",
    keyHint: "保存于 ~/.code-shell/settings.json，按 scope 隔离。生成的视频较慢,提交后台轮询,完成会通知。",
  },
};

export function VideoGenConnectionsPanel({ scope, activeRepoPath }: { scope: "user" | "project"; activeRepoPath: string | null }) {
  return <GenConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} config={VIDEO_CONFIG} />;
}
