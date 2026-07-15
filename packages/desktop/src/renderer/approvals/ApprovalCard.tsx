import React, { useState } from "react";
import { ChevronDown, Check, X } from "lucide-react";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import { RiskPill, riskFor } from "./RiskPill";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  approveOptionsFor,
  type ApproveChoice,
  type ApprovePathScope,
} from "./approvalDecision";
import { useT, type TFunction } from "../i18n/I18nProvider";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";

const DENY_PRESETS = [
  "looks unsafe",
  "not in scope",
  "wrong target",
  "ask again with different approach",
];

interface Props {
  envelope: ApprovalRequestEnvelope;
  /**
   * `scope` is the approve range (once/session/project) and `pathScope` the
   * optional path narrowing (file/dir/tool, file tools only); both omitted on
   * deny. App threads them into the engine's ApprovalResult.
   */
  onDecide: (
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ) => void;
}

/** Short confirmation shown once a choice is made (optimistic terminal state). */
export function decidedLabel(d: {
  kind: "approve" | "deny";
  scope?: ApproveChoice;
  label?: string;
}): string {
  const lang = loadUILanguage();
  if (d.kind === "deny") return translate(lang, "auto.approvalCard.denied");
  if (d.scope && d.scope !== "once")
    return translate(lang, "auto.approvalCard.approvedScope", { label: d.label ?? d.scope });
  return translate(lang, "auto.approvalCard.approved");
}

export function ApprovalCard({ envelope, onDecide }: Props) {
  const { t } = useT();
  const { request } = envelope;
  const [showRaw, setShowRaw] = useState(false);
  const [denyReason, setDenyReason] = useState<string>("");
  // Optimistic terminal state: set the instant the user clicks so the card
  // shows a confirmation and disables its controls immediately, regardless of
  // how long the worker takes to resume the turn and run the tool.
  const [decided, setDecided] = useState<{
    kind: "approve" | "deny";
    scope?: ApproveChoice;
    label?: string;
  } | null>(null);
  const argsJson = JSON.stringify(request.args ?? {});
  // Engine supplies riskLevel authoritatively; fall back to heuristic
  // only if missing (e.g. older worker versions).
  const risk = (request.riskLevel as "low" | "medium" | "high" | undefined)
    ?? riskFor(request.toolName, argsJson);
  const summary = summarizeRequest(request, t);

  // Path-scoped options for file tools (Write/Edit) — pulls file_path so the
  // menu can offer "this file / this dir / all paths".
  const filePath =
    typeof (request.args as Record<string, unknown>)?.file_path === "string"
      ? ((request.args as Record<string, unknown>).file_path as string)
      : undefined;
  const options = approveOptionsFor(request.toolName, filePath);
  // Promote the first "session" grant to its own visible button (the common
  // "stop asking me this session" case); everything else (项目, path-scoped
  // file/dir grants) folds into the 更多范围 ▾ menu. "once" is its own button.
  const sessionOption = options.find((o) => o.scope === "session");
  const moreOptions = options.filter((o) => o.scope !== "once" && o !== sessionOption);

  const approve = (scope: ApproveChoice, pathScope?: ApprovePathScope, label?: string): void => {
    if (decided) return;
    setDecided({ kind: "approve", scope, label });
    onDecide("approve", undefined, scope, pathScope);
  };
  const deny = (): void => {
    if (decided) return;
    setDecided({ kind: "deny" });
    onDecide("deny", denyReason || undefined);
  };

  return (
    <div className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold">{request.toolName}</span>
        <RiskPill level={risk} />
        {request.description && (
          <span className="truncate text-xs text-muted-foreground" title={request.description}>
            {request.description}
          </span>
        )}
      </div>
      <div className="mt-2 break-all font-mono text-sm">{summary}</div>

      <button
        className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setShowRaw((s) => !s)}
      >
        {showRaw ? t("auto.approvalCard.hideRaw") : t("auto.approvalCard.showRaw")}
      </button>
      {showRaw && (
        <pre className="mt-1 overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {JSON.stringify(request.args ?? {}, null, 2)}
        </pre>
      )}

      {decided ? (
        <div
          className={
            "mt-3 flex items-center gap-1.5 text-sm " +
            (decided.kind === "approve" ? "text-status-ok" : "text-status-err")
          }
        >
          {decided.kind === "approve" ? <Check size={15} /> : <X size={15} />}
          <span>{decidedLabel(decided)}</span>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {/* Approve row. The two most-used scopes are explicit buttons so
              "本会话一直允许" is visible at a glance (it used to be buried in a
              ▾ menu). Any extra scopes — "本项目", or the file/dir path-scoped
              grants for Write/Edit — fold into the "更多范围 ▾" menu. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => approve("once")}>
              {t("auto.approvalCard.approveOnce")}
            </Button>
            {sessionOption && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  approve(sessionOption.scope, sessionOption.pathScope, sessionOption.label)
                }
              >
                {sessionOption.label}
              </Button>
            )}
            {moreOptions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" aria-label={t("auto.approvalCard.selectScope")}>
                    {t("auto.approvalCard.moreScope")} <ChevronDown size={14} className="ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-[18rem]">
                  {moreOptions.map((o) => (
                    <DropdownMenuItem
                      key={`${o.scope}:${o.pathScope ?? "tool"}`}
                      className="flex flex-col items-start gap-0"
                      onSelect={() => approve(o.scope, o.pathScope, o.label)}
                    >
                      <span>{o.label}</span>
                      {o.hint && (
                        <span className="text-xs text-muted-foreground">{o.hint}</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {/* Deny row — clearly labelled and separated so the reason picker is
              never mistaken for a generic "type your decision" box (it only
              ever feeds the 拒绝 button). */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
            <Button size="sm" variant="ghost" className="text-status-err" onClick={deny}>
              {t("auto.approvalCard.deny")}
            </Button>
            <Select value={denyReason} onValueChange={setDenyReason}>
              <SelectTrigger className="h-8 w-[200px]">
                <SelectValue placeholder={t("auto.approvalCard.denyReasonPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {DENY_PRESETS.map((r) => (
                  <SelectItem key={r} value={r}>{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

function summarizeRequest(req: ApprovalRequestEnvelope["request"], t: TFunction): string {
  const args = (req.args ?? {}) as Record<string, unknown>;
  if (req.toolName === "ReadSource") {
    return t("auto.approvalCard.readSourceSummary", {
      source: stringArg(args.source),
      scope: stringArg(args.scope),
      resource: stringArg(args.resource),
    });
  }
  const candidates: Array<keyof typeof args> = ["command", "file_path", "path", "url", "pattern", "query"];
  for (const k of candidates) {
    const v = args[k];
    if (typeof v === "string") return v;
  }
  return req.toolName;
}

function stringArg(value: unknown): string {
  return typeof value === "string" && value ? value : "—";
}
