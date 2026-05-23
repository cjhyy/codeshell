import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ViewMode } from "../view";

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
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
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
              setCursor((c) => Math.min(c + 1, filtered.length - 1));
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
        <ul className="palette-list">
          {filtered.length === 0 ? (
            <li className="palette-empty">没有匹配的命令</li>
          ) : (
            filtered.map((c, i) => (
              <li
                key={c.id}
                className={`palette-item${i === cursor ? " active" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  c.run();
                  onClose();
                }}
              >
                <span className="palette-item-label">{c.label}</span>
                {c.hint && <span className="palette-item-hint">{c.hint}</span>}
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
  toggleSidebar: () => void;
  toggleInspector: () => void;
  clearTranscript: () => void;
  openSearch: () => void;
}): PaletteCommand[] {
  const { setViewMode, toggleSidebar, toggleInspector, clearTranscript, openSearch } = opts;
  return [
    { id: "go.chat", label: "打开 对话", run: () => setViewMode("chat") },
    { id: "go.sessions", label: "打开 会话", run: () => setViewMode("sessions") },
    { id: "go.approvals", label: "打开 审批", run: () => setViewMode("approvals") },
    { id: "go.runs", label: "打开 运行", run: () => setViewMode("runs") },
    { id: "go.mcp", label: "打开 插件", run: () => setViewMode("mcp") },
    { id: "go.logs", label: "打开 日志", run: () => setViewMode("logs") },
    { id: "go.settings", label: "打开 设置", run: () => setViewMode("settings") },
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
