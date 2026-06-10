import React from "react";
import { GenConnectionsPanel, type GenPanelConfig, type ProviderMeta } from "./GenConnectionsPanel";

const VIDEO_PROVIDERS: ProviderMeta[] = [
  {
    id: "fal",
    kind: "fal",
    displayName: "fal.ai (Kling / 即梦 Seedance 等)",
    description:
      "通过 fal.ai 统一 API 调用 Kling、即梦(Seedance,字节同源)等视频模型。需要 fal key；" +
      "「默认模型」决定底层模型与文生/图生(传图自动切图生)。即梦 = fal 上的 bytedance/seedance 模型,选它即可。",
    defaultBaseUrl: "https://queue.fal.run",
    defaultModel: "fal-ai/kling-video/v3/pro/text-to-video",
    signupUrl: "https://fal.ai/dashboard/keys",
    // 即梦(Seedance)与 Kling 都走 fal,差别只在 model id。可选可手填。
    modelPresets: [
      { value: "bytedance/seedance-2.0/text-to-video", label: "即梦 Seedance 2.0 · 文生视频" },
      { value: "bytedance/seedance-2.0/image-to-video", label: "即梦 Seedance 2.0 · 图生视频" },
      { value: "fal-ai/kling-video/v3/pro/text-to-video", label: "Kling v3 Pro · 文生视频" },
      { value: "fal-ai/kling-video/v3/pro/image-to-video", label: "Kling v3 Pro · 图生视频" },
    ],
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
