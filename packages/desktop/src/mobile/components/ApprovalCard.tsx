import { useState } from "react";
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

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 shadow-sm",
        approval.risk === "high" ? "border-status-err/60" : "border-border",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-sm font-semibold text-foreground">
          {approval.toolName}
        </span>
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
            RISK_TONE[approval.risk],
          )}
        >
          {RISK_LABEL[approval.risk]}
        </span>
      </div>
      {approval.description && (
        <p className="mb-2 text-xs text-muted-foreground">{approval.description}</p>
      )}
      <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px] text-foreground/90">
        {approval.summary}
      </pre>

      {isAsk ? (
        // AskUser approval: tap an option, or type a free answer (if allowed).
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {approval.options!.map((opt) => (
              <Button
                key={opt}
                size="sm"
                variant="outline"
                onClick={() => onRespond("approve", { answer: opt })}
              >
                {opt}
              </Button>
            ))}
          </div>
          {!approval.optionsOnly && (
            <div className="flex gap-2">
              <Textarea
                rows={1}
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="或输入自定义回答…"
                className="min-h-9 flex-1 text-sm"
              />
              <Button
                size="sm"
                disabled={!freeText.trim()}
                onClick={() => onRespond("approve", { answer: freeText.trim() })}
              >
                回答
              </Button>
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={() => onRespond("reject")}>
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
              className="flex-1"
              onClick={() =>
                onRespond("approve", {
                  scope,
                  pathScope: approval.pathScoped ? pathScope : undefined,
                })
              }
            >
              允许
            </Button>
            <Button className="flex-1" variant="outline" onClick={() => onRespond("reject")}>
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
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([v, lbl]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px]",
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
