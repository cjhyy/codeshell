import React, { useState } from "react";
import type { ApprovalRequestEnvelope } from "../preload/types";

interface Props {
  envelope: ApprovalRequestEnvelope;
  onDecide: (decision: "approve" | "deny", reason?: string) => void;
}

export function ApprovalModal({ envelope, onDecide }: Props) {
  const [denyReason, setDenyReason] = useState("");
  const { request } = envelope;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Tool approval needed</h3>
        <div className="modal-body">
          <div><strong>Tool:</strong> {request.toolName}</div>
          <div className="modal-risk"><strong>Risk:</strong> {request.riskLevel}</div>
          <pre className="modal-args">{JSON.stringify(request.args ?? {}, null, 2)}</pre>
          {request.description && (
            <div className="modal-desc"><em>{request.description}</em></div>
          )}
        </div>
        <div className="modal-actions">
          <input
            type="text"
            placeholder="optional deny reason"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
          />
          <button onClick={() => onDecide("deny", denyReason || undefined)}>Deny</button>
          <button className="primary" onClick={() => onDecide("approve")}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
