import React, { useState } from "react";
import type { ToolMessage } from "../types";
import { Lightbox } from "../chat/Lightbox";
import { ToolCardShell } from "./ToolCardShell";
import { parsedArgs, truncate } from "./utils";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  turnEpoch?: number;
}

/** Browser-specific card: visual observations stay visible in the timeline. */
export function BrowserToolCard({ message, onSelect, selected, turnEpoch }: Props) {
  const args = parsedArgs(message);
  const images = message.images ?? [];
  const [zoom, setZoom] = useState<number | null>(null);
  const imageSrc = (index: number) =>
    `data:${images[index]!.mediaType};base64,${images[index]!.data}`;

  const preview =
    images.length > 0 ? (
      <div className="flex flex-col gap-2" data-browser-screenshot-preview>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
            页面截图
          </span>
          <span className="text-[11px] text-muted-foreground">
            {images.length > 1 ? `${images.length} 张 · 点击放大` : "点击放大"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {images.map((_, index) => (
            <button
              key={index}
              type="button"
              className="overflow-hidden rounded-md border border-border bg-muted/30 transition hover:border-primary"
              onClick={(event) => {
                event.stopPropagation();
                setZoom(index);
              }}
              title="点击放大页面截图"
            >
              <img
                src={imageSrc(index)}
                alt={`页面截图 ${index + 1}`}
                className="block max-h-56 max-w-full object-contain sm:max-w-[28rem]"
              />
            </button>
          ))}
        </div>
      </div>
    ) : undefined;

  const details = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
          参数
        </span>
        <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">
          {JSON.stringify(args, null, 2)}
        </pre>
      </div>
      {message.result !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
            结果
          </span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">
            {truncate(message.result, 1500)}
          </pre>
        </div>
      )}
      {message.error && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
            错误
          </span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-status-err/10 p-2 font-mono text-xs text-status-err">
            {message.error}
          </pre>
        </div>
      )}
    </div>
  );

  return (
    <>
      <ToolCardShell
        message={message}
        summary={<span className="text-muted-foreground">{browserSummary(message, args)}</span>}
        preview={preview}
        details={details}
        onSelect={onSelect}
        selected={selected}
        turnEpoch={turnEpoch}
      />
      {zoom !== null && images[zoom] && (
        <Lightbox
          src={imageSrc(zoom)}
          alt={`页面截图 ${zoom + 1}`}
          onClose={() => setZoom(null)}
          items={images.map((_, index) => ({
            src: imageSrc(index),
            alt: `页面截图 ${index + 1}`,
          }))}
          index={zoom}
        />
      )}
    </>
  );
}

export function browserSummary(
  message: Pick<ToolMessage, "toolName" | "status">,
  args: Record<string, unknown>,
): string {
  const name = message.toolName.toLowerCase();
  if (message.status === "running") {
    if (name === "browser_navigate") return `正在打开 ${shortUrl(args.url)}`;
    if (name === "browser_observe") return "正在观察页面";
    return `正在执行${actionLabel(args.action)}`;
  }
  if (name === "browser_navigate") return `已打开 ${shortUrl(args.url)}`;
  if (name === "browser_observe") {
    switch (args.mode ?? "snapshot") {
      case "vision":
        return "已截取页面画面";
      case "image":
        return "已读取页面图片";
      case "read":
        return "已读取页面正文";
      case "extract":
        return "已提取页面链接与媒体";
      default:
        return "已读取页面结构";
    }
  }
  return `已${actionLabel(args.action)}`;
}

function actionLabel(action: unknown): string {
  switch (action) {
    case "click":
      return "点击页面元素";
    case "type":
      return "输入文字";
    case "select":
      return "选择选项";
    case "press_key":
      return "发送按键";
    case "hover":
      return "悬停";
    case "scroll":
      return "滚动页面";
    case "wait":
      return "等待页面";
    case "list_tabs":
      return "读取标签页";
    case "switch_tab":
      return "切换标签页";
    default:
      return "操作浏览器";
  }
}

function shortUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return "网页";
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return truncate(value, 80);
  }
}
