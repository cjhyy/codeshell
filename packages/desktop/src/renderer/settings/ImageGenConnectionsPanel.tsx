import React from "react";
import { GenConnectionsPanel, type GenPanelConfig } from "./GenConnectionsPanel";

const IMAGE_CONFIG: GenPanelConfig = {
  settingsKey: "imageGen",
  catalogTag: "image",
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
