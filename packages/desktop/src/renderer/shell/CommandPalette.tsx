import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Command as CommandIcon } from "lucide-react";
import type { ViewMode, PanelTab } from "../view";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useT } from "../i18n/I18nProvider";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";
import { SearchDialog } from "./SearchDialog";

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
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setFilter("");
  }, [open]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(q) || command.hint?.toLowerCase().includes(q),
    );
  }, [commands, filter]);

  return (
    <SearchDialog
      open={open}
      onClose={onClose}
      title={t("panels.palette.title")}
      inputRef={inputRef}
    >
      <Command
        label={t("panels.palette.title")}
        shouldFilter={false}
        vimBindings={false}
        className="min-h-0 rounded-none bg-transparent"
      >
        <CommandInput
          ref={inputRef}
          className="h-12 text-sm"
          value={filter}
          placeholder={t("panels.palette.typeCommand")}
          onValueChange={setFilter}
        />
        <CommandList label={t("panels.palette.results")} className="min-h-0 max-h-[55vh] p-2">
          {filtered.length === 0 ? (
            <div
              role="status"
              className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted-foreground"
            >
              <CommandIcon className="size-6 opacity-60" aria-hidden />
              {t("panels.palette.noMatch")}
            </div>
          ) : (
            filtered.map((command) => (
              <CommandItem
                key={command.id}
                value={command.id}
                className="min-w-0 justify-between gap-3 rounded-lg px-3 py-2.5 text-sm"
                onSelect={() => {
                  command.run();
                  onClose();
                }}
              >
                <span className="min-w-0 truncate font-medium">{command.label}</span>
                {command.hint ? (
                  <kbd className="shrink-0 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground">
                    {command.hint}
                  </kbd>
                ) : (
                  <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
              </CommandItem>
            ))
          )}
        </CommandList>
      </Command>
    </SearchDialog>
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
  const { setViewMode, openPanel, toggleSidebar, toggleInspector, clearTranscript, openSearch } =
    opts;
  // buildCommands is a plain function called inline from App's render (no hook
  // access here). Translate against the active stored language so labels follow
  // the language switch on the next render.
  const lang = loadUILanguage();
  const tt = (key: string) => translate(lang, key);
  return [
    { id: "go.chat", label: tt("panels.palette.openChat"), run: () => setViewMode("chat") },
    {
      id: "go.files",
      label: tt("panels.palette.openFiles"),
      hint: "Cmd+Shift+E",
      run: () => openPanel("files"),
    },
    {
      id: "go.browser",
      label: tt("panels.palette.openBrowser"),
      hint: "Cmd+T",
      run: () => openPanel("browser"),
    },
    {
      id: "go.review",
      label: tt("panels.palette.openReview"),
      hint: "Ctrl+Shift+G",
      run: () => openPanel("review"),
    },
    {
      id: "go.terminal",
      label: tt("panels.palette.openTerminal"),
      hint: "Ctrl+`",
      run: () => openPanel("terminal"),
    },
    {
      id: "go.quickChat",
      label: tt("panels.palette.openQuickChat"),
      run: () => openPanel("quickChat"),
    },
    {
      id: "go.sessions",
      label: tt("panels.palette.openSessions"),
      run: () => setViewMode("sessions"),
    },
    {
      id: "go.approvals",
      label: tt("panels.palette.openApprovals"),
      run: () => setViewMode("approvals"),
    },
    { id: "go.runs", label: tt("panels.palette.openRuns"), run: () => setViewMode("runs") },
    // 扩展并入设置中心(双门收口)— palette 直达设置页,扩展在其左侧导航里。
    {
      id: "go.settings",
      label: tt("panels.palette.openSettings"),
      run: () => setViewMode("settings_page"),
    },
    { id: "go.logs", label: tt("panels.palette.openLogs"), run: () => setViewMode("logs") },
    {
      id: "toggle.sidebar",
      label: tt("panels.palette.toggleSidebar"),
      hint: "Cmd+B",
      run: toggleSidebar,
    },
    {
      id: "toggle.inspector",
      label: tt("panels.palette.toggleInspector"),
      hint: "Cmd+I",
      run: toggleInspector,
    },
    { id: "transcript.clear", label: tt("panels.palette.clearTranscript"), run: clearTranscript },
    {
      id: "search.open",
      label: tt("panels.palette.searchTranscript"),
      hint: "Cmd+F",
      run: openSearch,
    },
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
