import React from "react";
import { ExternalLink } from "lucide-react";
import { useT } from "../i18n/I18nProvider";
import type { OpenCliSessionEventDetail } from "./types";

export function DriveAgentLinkButton({ detail }: { detail: OpenCliSessionEventDetail }) {
  const { t } = useT();
  const label = t(
    detail.cliKind === "codex"
      ? "panels.shells.openCodexSession"
      : "panels.shells.openClaudeSession",
  );

  return (
    <button
      type="button"
      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("codeshell:open-cli-session", {
            detail,
          }),
        );
      }}
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </button>
  );
}
