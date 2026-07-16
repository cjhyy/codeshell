import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ViewMode, PanelTab } from "../view";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";

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
  const { t } = useT();
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
          placeholder={t("panels.palette.typeCommand")}
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
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">{t("panels.palette.noMatch")}</li>
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
  // buildCommands is a plain function called inline from App's render (no hook
  // access here). Translate against the active stored language so labels follow
  // the language switch on the next render.
  const lang = loadUILanguage();
  const tt = (key: string) => translate(lang, key);
  return [
    { id: "go.chat", label: tt("panels.palette.openChat"), run: () => setViewMode("chat") },
    { id: "go.files", label: tt("panels.palette.openFiles"), hint: "Cmd+Shift+E", run: () => openPanel("files") },
    { id: "go.browser", label: tt("panels.palette.openBrowser"), hint: "Cmd+T", run: () => openPanel("browser") },
    { id: "go.review", label: tt("panels.palette.openReview"), hint: "Ctrl+Shift+G", run: () => openPanel("review") },
    { id: "go.terminal", label: tt("panels.palette.openTerminal"), hint: "Ctrl+`", run: () => openPanel("terminal") },
    { id: "go.quickChat", label: tt("panels.palette.openQuickChat"), run: () => openPanel("quickChat") },
    { id: "go.sessions", label: tt("panels.palette.openSessions"), run: () => setViewMode("sessions") },
    { id: "go.approvals", label: tt("panels.palette.openApprovals"), run: () => setViewMode("approvals") },
    { id: "go.runs", label: tt("panels.palette.openRuns"), run: () => setViewMode("runs") },
    // 扩展并入设置中心(双门收口)— palette 直达设置页,扩展在其左侧导航里。
    { id: "go.settings", label: tt("panels.palette.openSettings"), run: () => setViewMode("settings_page") },
    { id: "go.logs", label: tt("panels.palette.openLogs"), run: () => setViewMode("logs") },
    { id: "toggle.sidebar", label: tt("panels.palette.toggleSidebar"), hint: "Cmd+B", run: toggleSidebar },
    { id: "toggle.inspector", label: tt("panels.palette.toggleInspector"), hint: "Cmd+I", run: toggleInspector },
    { id: "transcript.clear", label: tt("panels.palette.clearTranscript"), run: clearTranscript },
    { id: "search.open", label: tt("panels.palette.searchTranscript"), hint: "Cmd+F", run: openSearch },
    {
      id: "window.new",
      label: tt("panels.palette.newWindow"),
      hint: "Cmd+Shift+N",
      run: () => {
        void window.codeshell.newWindow();
      },
    },
  ];
}
