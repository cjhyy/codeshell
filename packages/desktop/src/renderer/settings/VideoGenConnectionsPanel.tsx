import React from "react";

/**
 * Video-generation connections (TODO 7.1).
 *
 * Deliberately a placeholder for now: the core `videoGen.providers[]` schema +
 * GenerateVideo tool + VideoProvider submit/poll/download interface all exist,
 * but NO concrete adapter is wired yet (VIDEO_PROVIDER_KINDS is empty —
 * Seedance/Kling need accurate private-API endpoint+auth docs). A full
 * configure/test panel here would test against a backend that can't generate
 * video, so we show the honest state instead of a broken form. Swap this for a
 * real grid (mirroring ImageGenConnectionsPanel) once getVideoProvider() gains
 * a case.
 */
export function VideoGenConnectionsPanel(_props: {
  scope: "user" | "project";
  activeRepoPath: string | null;
}) {
  return (
    <div className="connections-card-grid">
      <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        视频生成 provider 暂未接入。核心已就绪(<code>videoGen.providers[]</code> schema、
        GenerateVideo 工具、submit/poll/download 适配器接口),仅缺具体厂商适配器
        (即梦 / Seedance、可灵 / Kling 等私有 API 的端点与鉴权)。拿到准确文档、
        在 <code>getVideoProvider()</code> 加 case 后,这里会换成与「图片生成」一致的
        配置 / 测试 / 默认 provider 面板。
      </div>
    </div>
  );
}
