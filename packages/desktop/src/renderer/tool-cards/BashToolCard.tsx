import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { classifyBashLines, parsedArgs, truncate } from "./utils";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  turnEpoch?: number;
}

/**
 * Render Bash output with error lines tinted (A1). The `STDERR:` section and
 * `Exit code:` / `Killed by signal:` status lines render in the error color;
 * everything else is plain. Lines are re-joined with `\n` so the rendered
 * `<pre>` reads (and copies) byte-for-byte the same as the raw output.
 */
function renderBashOutput(result: string): React.ReactNode {
  const classified = classifyBashLines(result.split("\n"));
  if (!classified.some((c) => c.isError)) return result; // fast path: no errors
  return classified.map((c, i) => (
    <React.Fragment key={i}>
      {i > 0 ? "\n" : null}
      {c.isError ? <span className="text-status-err">{c.text}</span> : c.text}
    </React.Fragment>
  ));
}

export function BashToolCard({ message, onSelect, selected, turnEpoch }: Props) {
  const a = parsedArgs(message);
  const command = typeof a.command === "string" ? a.command : "";
  const cwd = typeof a.cwd === "string" ? a.cwd : undefined;
  const description =
    typeof a.description === "string" ? a.description : undefined;

  const summary = (
    <span>
      <code className="tool-card-cmd">{truncate(command, 90)}</code>
      {description && <span className="tool-card-desc"> — {description}</span>}
    </span>
  );

  const details = (
    <div className="tool-card-detail">
      <div className="tool-card-row">
        <span className="tool-card-row-label">command</span>
        <pre className="tool-card-row-val">{command || "(empty)"}</pre>
      </div>
      {cwd && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">cwd</span>
          <span className="tool-card-row-val mono">{cwd}</span>
        </div>
      )}
      {message.result !== undefined && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">stdout</span>
          <pre className="tool-card-row-val">{renderBashOutput(message.result)}</pre>
        </div>
      )}
      {message.error && (
        <div className="tool-card-row">
          <span className="tool-card-row-label">error</span>
          <pre className="tool-card-row-val err">{message.error}</pre>
        </div>
      )}
    </div>
  );

  return (
    <ToolCardShell
      message={message}
      summary={summary}
      details={details}
      onSelect={onSelect}
      selected={selected}
      turnEpoch={turnEpoch}
    />
  );
}
