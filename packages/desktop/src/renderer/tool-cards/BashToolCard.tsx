import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { SandboxBadge } from "./SandboxBadge";
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
      <code className="font-mono text-foreground">{truncate(command, 90)}</code>
      {description && <span className="text-muted-foreground"> — {description}</span>}
    </span>
  );

  const details = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">command</span>
        <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{command || "(empty)"}</pre>
      </div>
      {cwd && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">cwd</span>
          <span className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{cwd}</span>
        </div>
      )}
      {message.result !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">stdout</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{renderBashOutput(message.result)}</pre>
        </div>
      )}
      {message.error && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">error</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-status-err/10 p-2 font-mono text-xs text-status-err">{message.error}</pre>
        </div>
      )}
    </div>
  );

  return (
    <ToolCardShell
      message={message}
      summary={summary}
      details={details}
      headerBadge={message.sandbox && <SandboxBadge sandbox={message.sandbox} />}
      onSelect={onSelect}
      selected={selected}
      turnEpoch={turnEpoch}
    />
  );
}
