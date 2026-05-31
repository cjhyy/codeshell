import React, { useState } from "react";
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

const DENY_PRESETS = [
  "looks unsafe",
  "not in scope",
  "wrong target",
  "ask again with different approach",
];

interface Props {
  envelope: ApprovalRequestEnvelope;
  onDecide: (decision: "approve" | "deny", reason?: string) => void;
}

export function ApprovalCard({ envelope, onDecide }: Props) {
  const { request } = envelope;
  const [showRaw, setShowRaw] = useState(false);
  const [denyReason, setDenyReason] = useState<string>("");
  const argsJson = JSON.stringify(request.args ?? {});
  // Engine supplies riskLevel authoritatively; fall back to heuristic
  // only if missing (e.g. older worker versions).
  const risk = (request.riskLevel as "low" | "medium" | "high" | undefined)
    ?? riskFor(request.toolName, argsJson);
  const summary = summarizeRequest(request);

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

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={() => onDecide("approve")}>批准</Button>
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
        <Button
          size="sm"
          variant="ghost"
          className="text-status-err"
          onClick={() => onDecide("deny", denyReason || undefined)}
        >
          拒绝
        </Button>
      </div>
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
