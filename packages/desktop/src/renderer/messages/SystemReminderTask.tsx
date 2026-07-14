import React, { useState } from "react";
import { ChevronRight, ListChecks } from "lucide-react";
import { isSystemReminderText } from "../contextSelection";
import { useT } from "../i18n/I18nProvider";

function reminderBody(text: string): string {
  if (!isSystemReminderText(text)) return text.trim();
  return text
    .replace(/^\s*<system-reminder>\s*/, "")
    .replace(/\s*<\/system-reminder>\s*$/, "")
    .trim();
}

/** Render an injected reminder as folded task metadata, never as a user bubble. */
export function SystemReminderTask({ text }: { text: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className="px-4 py-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          size={13}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <ListChecks size={13} className="shrink-0" />
        <span>{t("chat.contextPackage.systemTask")}</span>
      </button>
      {open && (
        <div className="ml-7 mt-1 whitespace-pre-wrap break-words border-l border-border pl-3 text-xs text-muted-foreground">
          {reminderBody(text)}
        </div>
      )}
    </div>
  );
}
