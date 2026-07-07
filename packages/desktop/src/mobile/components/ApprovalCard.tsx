import { useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import { Textarea } from "@ui/textarea";
import type { ApprovalScope, ApprovalPathScope } from "@protocol";
import type { PendingApproval } from "@mobile/hooks/useRemoteApp";

export interface ApprovalResponse {
  reason?: string;
  answer?: string;
  scope?: ApprovalScope;
  pathScope?: ApprovalPathScope;
}

const RISK_TONE: Record<PendingApproval["risk"], string> = {
  low: "border-status-ok/40 text-status-ok",
  medium: "border-status-warn/50 text-status-warn",
  high: "border-status-err/60 text-status-err",
};

const RISK_LABEL: Record<PendingApproval["risk"], string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

/** A pending permission request, with full desktop-parity controls:
 *  approve/deny, remembered scope (once/session/project), path scope
 *  (file/dir for path-scoped tools), and AskUser options / free-text answer. */
export function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (decision: "approve" | "reject", opts?: ApprovalResponse) => void;
}) {
  const isAsk = Boolean(approval.options?.length);
  const [scope, setScope] = useState<ApprovalScope>("once");
  const [pathScope, setPathScope] = useState<ApprovalPathScope>("tool");
  const [freeText, setFreeText] = useState("");
  const askQuestion = approval.summary || approval.description;
  const showDescription = Boolean(
    approval.description && (!isAsk || approval.description !== askQuestion),
  );

  return (
    <div
      className={cn(
        "mobile-glass rounded-xl p-3",
        approval.risk === "high" ? "border-status-err/60" : "border-border",
      )}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-status-warn/12 text-status-warn">
          <ShieldAlert className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">
          {approval.toolName}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
            RISK_TONE[approval.risk],
          )}
        >
          {RISK_LABEL[approval.risk]}
        </span>
      </div>
      {showDescription && (
        <p className="mb-2 break-words text-xs text-muted-foreground">{approval.description}</p>
      )}
      {isAsk ? (
        <div className="mb-3 rounded-lg border border-border/70 bg-muted/30 p-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">问题</div>
          <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {askQuestion}
          </div>
        </div>
      ) : (
        <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/35 p-2.5 font-mono text-[11px] text-foreground/90">
          {approval.summary}
        </pre>
      )}

      {isAsk ? (
        // AskUser approval: tap an option, or type a free answer (if allowed).
        <div className="flex flex-col gap-2.5">
          <div className="flex min-w-0 flex-col gap-2">
            {approval.options!.map((opt, index) => (
              <button
                key={opt}
                type="button"
                className="mobile-list-item flex min-h-12 w-full min-w-0 items-center gap-2 rounded-lg border border-border/70 px-3 py-2.5 text-left hover:bg-primary/10"
                onClick={() => onRespond("approve", { answer: opt })}
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 whitespace-normal break-words text-sm leading-5 text-foreground">
                  {opt}
                </span>
                <Check className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
          {!approval.optionsOnly && (
            <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-black/10 p-2">
              <Textarea
                rows={2}
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="或输入自定义回答…"
                name="codeshell-answer"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                // text-base (16px): avoid iOS focus auto-zoom.
                className="min-h-16 min-w-0 resize-none rounded-lg text-base"
              />
              <Button
                size="sm"
                className="h-9 w-full rounded-lg"
                disabled={!freeText.trim()}
                onClick={() => onRespond("approve", { answer: freeText.trim() })}
              >
                <Check />
                发送自定义回答
              </Button>
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="rounded-lg"
            onClick={() => onRespond("reject")}
          >
            取消
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {/* Remembered scope */}
          <ScopeChips
            label="记住范围"
            value={scope}
            options={[
              ["once", "仅本次"],
              ["session", "本会话"],
              ["project", "本项目"],
            ]}
            onChange={(v) => setScope(v as ApprovalScope)}
          />
          {/* Path breadth, only for path-scoped tools and only when remembering */}
          {approval.pathScoped && scope !== "once" && (
            <ScopeChips
              label="路径范围"
              value={pathScope}
              options={[
                ["file", "此文件"],
                ["dir", "此目录"],
                ["tool", "此工具"],
              ]}
              onChange={(v) => setPathScope(v as ApprovalPathScope)}
            />
          )}
          <div className="flex gap-2">
            <Button
              className="h-10 flex-1 rounded-lg"
              onClick={() =>
                onRespond("approve", {
                  scope,
                  pathScope: approval.pathScoped ? pathScope : undefined,
                })
              }
            >
              <Check />
              允许
            </Button>
            <Button
              className="h-10 flex-1 rounded-lg"
              variant="outline"
              onClick={() => onRespond("reject")}
            >
              <X />
              拒绝
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeChips({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="grid min-w-0 grid-cols-3 gap-1">
        {options.map(([v, lbl]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              "min-h-8 rounded-lg border px-1.5 py-1 text-[11px]",
              value === v
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground",
            )}
          >
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}
