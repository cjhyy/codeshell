import React from "react";
import { ExternalLink } from "lucide-react";
import { useT } from "../i18n/I18nProvider";
import type { OpenCliSessionEventDetail } from "./types";

export function DriveAgentLinkButton({ detail }: { detail: OpenCliSessionEventDetail }) {
  const { t } = useT();
  const label = detail.jobId
    ? t("panels.shells.viewAgentProgress", {
        cli: detail.cliKind === "codex" ? "Codex" : "Claude Code",
      })
    : t(
        detail.cliKind === "codex"
          ? "panels.shells.openCodexSession"
          : "panels.shells.openClaudeSession",
      );

  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
      {detail.jobId && <span>{label}</span>}
    </button>
  );
}
