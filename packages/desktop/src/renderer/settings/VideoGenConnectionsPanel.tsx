import React from "react";
import { GenConnectionsPanel, type GenPanelConfig } from "./GenConnectionsPanel";

const VIDEO_CONFIG: GenPanelConfig = {
  settingsKey: "videoGen",
  catalogTag: "video",
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
