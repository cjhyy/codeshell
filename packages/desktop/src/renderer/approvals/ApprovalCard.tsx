import React, { useState } from "react";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import { RiskPill, riskFor } from "./RiskPill";
import { Select } from "../ui/Select";

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
    <div className={`approval-card risk-${risk}`}>
      <div className="approval-card-head">
        <span className="approval-card-tool">{request.toolName}</span>
        <RiskPill level={risk} />
        {request.description && (
          <span className="approval-card-cwd" title={request.description}>
            {request.description}
          </span>
        )}
      </div>
      <div className="approval-card-summary">{summary}</div>

      <button
        className="approval-card-raw-toggle"
        onClick={() => setShowRaw((s) => !s)}
      >
        {showRaw ? "hide raw args" : "show raw args"}
      </button>
      {showRaw && (
        <pre className="approval-card-raw">{JSON.stringify(request.args ?? {}, null, 2)}</pre>
      )}

      <div className="approval-card-actions">
        <button className="approval-btn approve" onClick={() => onDecide("approve")}>
          Approve
        </button>
        <div className="approval-deny-select">
          <Select
            size="sm"
            value={denyReason}
            onChange={setDenyReason}
            placeholder="deny reason…"
            options={DENY_PRESETS.map((r) => ({ value: r, label: r }))}
          />
        </div>
        <button
          className="approval-btn deny"
          onClick={() => onDecide("deny", denyReason || undefined)}
        >
          Deny
        </button>
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
