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
  if (d.kind === "deny") return "已拒绝";
  if (d.scope && d.scope !== "once") return `已批准 · ${d.label ?? d.scope}`;
  return "已批准";
}

export function ApprovalCard({ envelope, onDecide }: Props) {
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
  const summary = summarizeRequest(request);

  // Path-scoped options for file tools (Write/Edit) — pulls file_path so the
  // menu can offer "this file / this dir / all paths".
  const filePath =
    typeof (request.args as Record<string, unknown>)?.file_path === "string"
      ? ((request.args as Record<string, unknown>).file_path as string)
      : undefined;
  const options = approveOptionsFor(request.toolName, filePath);

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
        {showRaw ? "hide raw args" : "show raw args"}
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
        <div className="mt-3 flex items-center gap-2">
          {/* Approve split-button: main = once (the common case); ▾ opens the
              wider session/project scopes. */}
          <div className="flex">
            <Button size="sm" className="rounded-r-none" onClick={() => approve("once")}>
              批准
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
                  aria-label="选择批准范围"
                >
                  <ChevronDown size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-[18rem]">
                {/* once is the main button; the menu offers the remembered
                    (session/project) grants, expanded by path scope for file
                    tools. */}
                {options
                  .filter((o) => o.scope !== "once")
                  .map((o) => (
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
          </div>

          <Select value={denyReason} onValueChange={setDenyReason}>
            <SelectTrigger className="h-8 w-[200px]">
              <SelectValue placeholder="拒绝理由…" />
            </SelectTrigger>
            <SelectContent>
              {DENY_PRESETS.map((r) => (
                <SelectItem key={r} value={r}>{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" className="text-status-err" onClick={deny}>
            拒绝
          </Button>
        </div>
      )}
    </div>
  );
}

function summarizeRequest(req: ApprovalRequestEnvelope["request"]): string {
  const args = (req.args ?? {}) as Record<string, unknown>;
  const candidates: Array<keyof typeof args> = ["command", "file_path", "path", "url", "pattern", "query"];
  for (const k of candidates) {
    const v = args[k];
    if (typeof v === "string") return v;
  }
  return req.toolName;
}
