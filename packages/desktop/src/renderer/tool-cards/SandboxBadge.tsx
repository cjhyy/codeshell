import React from "react";
import { ShieldCheck, ShieldOff } from "../ui/icons";
import type { ToolMessage } from "../types";
import { useT } from "../i18n/I18nProvider";

/**
 * Small header chip showing whether THIS tool call ran under an OS-level
 * sandbox. Surfaced for shell-executing tools (Bash / background shell /
 * worktree) — file/search tools don't go through the sandbox and pass no
 * `sandbox`, so no badge renders.
 *
 *   backend "off"               → ⚠ 未隔离 (muted/warn) — explicit so the user
 *                                  sees the command ran un-sandboxed.
 *   backend seatbelt / bwrap    → 🛡 <backend>·<network> (ok) — isolated, with
 *                                  the network policy that applied.
 */
export function SandboxBadge({ sandbox }: { sandbox: NonNullable<ToolMessage["sandbox"]> }) {
  const { t } = useT();
  if (sandbox.backend === "off") {
    return (
      <span
        className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 text-xs text-muted-foreground"
        title={t("msg.sandbox.offTitle")}
      >
        <ShieldOff size={11} />
        {t("msg.sandbox.off")}
      </span>
    );
  }
  const net = sandbox.network ? t(`msg.sandbox.net.${sandbox.network}`) : "";
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded border border-status-ok/40 px-1.5 text-xs text-status-ok"
      title={t("msg.sandbox.onTitle", { backend: sandbox.backend, network: net ? ` · ${net}` : "" })}
    >
      <ShieldCheck size={11} />
      {sandbox.backend}
      {net && <span className="opacity-70">·{net}</span>}
    </span>
  );
}
