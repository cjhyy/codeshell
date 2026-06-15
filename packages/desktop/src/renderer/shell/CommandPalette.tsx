import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ViewMode, PanelTab } from "../view";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

export function CommandPalette({ open, onClose, commands }: Props) {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setFilter("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.hint ? c.hint.toLowerCase().includes(q) : false),
    );
  }, [commands, filter]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 px-4 pt-[14vh]" onClick={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <Input
          ref={inputRef}
          className="h-11 rounded-none border-0 border-b bg-transparent px-3 shadow-none focus-visible:ring-0"
          value={filter}
          placeholder="键入命令…"
          onChange={(e) => {
            setFilter(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              // max(0, …) so an empty list (length-1 === -1) keeps cursor at 0.
              setCursor((c) => Math.max(0, Math.min(c + 1, filtered.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const cmd = filtered[cursor];
              if (cmd) {
                cmd.run();
                onClose();
              }
            }
          }}
        />
        <ul className="max-h-[55vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">没有匹配的命令</li>
          ) : (
            filtered.map((c, i) => (
              <li
                key={c.id}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 text-sm",
                  i === cursor ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
                )}
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  c.run();
                  onClose();
                }}
              >
                <span className="font-medium">{c.label}</span>
                {c.hint && <span className="text-xs text-muted-foreground">{c.hint}</span>}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

/** Build the standard command set the palette exposes. */
export function buildCommands(opts: {
  setViewMode: (v: ViewMode) => void;
  openPanel: (t: PanelTab) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  clearTranscript: () => void;
  openSearch: () => void;
}): PaletteCommand[] {
  const { setViewMode, openPanel, toggleSidebar, toggleInspector, clearTranscript, openSearch } = opts;
  return [
    { id: "go.chat", label: "打开 对话", run: () => setViewMode("chat") },
    { id: "go.files", label: "打开 文件", hint: "Cmd+Shift+E", run: () => openPanel("files") },
    { id: "go.browser", label: "打开 浏览器", hint: "Cmd+T", run: () => openPanel("browser") },
    { id: "go.review", label: "打开 审查", hint: "Ctrl+Shift+G", run: () => openPanel("review") },
    { id: "go.terminal", label: "打开 终端", hint: "Ctrl+`", run: () => openPanel("terminal") },
    { id: "go.sessions", label: "打开 会话", run: () => setViewMode("sessions") },
    { id: "go.approvals", label: "打开 审批", run: () => setViewMode("approvals") },
    { id: "go.runs", label: "打开 运行", run: () => setViewMode("runs") },
    { id: "go.extensions", label: "打开 扩展", run: () => setViewMode("customize") },
    { id: "go.logs", label: "打开 日志", run: () => setViewMode("logs") },
    // 设置改为左下角上拉菜单 — 不再由 viewMode 驱动，所以不放进 palette。
    { id: "toggle.sidebar", label: "切换 侧栏", hint: "Cmd+B", run: toggleSidebar },
    { id: "toggle.inspector", label: "切换 详情", hint: "Cmd+I", run: toggleInspector },
    { id: "transcript.clear", label: "清空当前 transcript", run: clearTranscript },
    { id: "search.open", label: "搜索当前 transcript", hint: "Cmd+F", run: openSearch },
    {
      id: "window.new",
      label: "新窗口",
      hint: "Cmd+Shift+N",
      run: () => {
        void window.codeshell.newWindow();
      },
    },
  ];
}
