import React from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { parsedArgs, truncate } from "./utils";
import { classifyPath } from "./attachments";
import { AttachmentCard } from "./AttachmentCard";
import { OpenWithMenu } from "../chat/OpenWithMenu";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  /** "read" or "write" — affects the summary verbiage and detail layout. */
  variant: "read" | "write" | "edit";
  turnEpoch?: number;
}

export function FileToolCard({ message, onSelect, selected, variant, turnEpoch }: Props) {
  const { t } = useT();
  const a = parsedArgs(message);
  const path =
    (typeof a.file_path === "string" && a.file_path) ||
    (typeof a.path === "string" && a.path) ||
    "";
  const offset = typeof a.offset === "number" ? a.offset : undefined;
  const limit = typeof a.limit === "number" ? a.limit : undefined;
  const content = typeof a.content === "string" ? a.content : undefined;
  const oldStr = typeof a.old_string === "string" ? a.old_string : undefined;
  const newStr = typeof a.new_string === "string" ? a.new_string : undefined;

  const range =
    offset !== undefined && limit !== undefined
      ? `lines ${offset + 1}–${offset + limit}`
      : limit !== undefined
        ? `${limit} lines`
        : null;

  const summary = (
    <span>
      <span className="font-mono text-foreground">{truncate(path, 70)}</span>
      {range && <span className="text-muted-foreground"> {range}</span>}
      {variant === "write" && content !== undefined && (
        <span className="text-muted-foreground"> ({content.length}B)</span>
      )}
    </span>
  );

  const details = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">path</span>
        <span className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{path}</span>
        {path && (
          <OpenWithMenu path={path} align="end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mt-1 h-7 w-7 self-start text-muted-foreground hover:text-foreground"
              title={t("msg.tool.openWith")}
              aria-label={t("msg.tool.openWith")}
            >
              <MoreHorizontal size={14} />
            </Button>
          </OpenWithMenu>
        )}
      </div>
      {variant === "edit" && (
        <>
          {oldStr !== undefined && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">- old</span>
              <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-status-err/10 p-2 font-mono text-xs text-status-err">{truncate(oldStr, 800)}</pre>
            </div>
          )}
          {newStr !== undefined && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">+ new</span>
              <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-status-ok/10 p-2 font-mono text-xs text-status-ok">{truncate(newStr, 800)}</pre>
            </div>
          )}
        </>
      )}
      {variant === "write" && content !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">content</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{truncate(content, 800)}</pre>
        </div>
      )}
      {variant === "write" && path && writeAttachmentKind(path, message) && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">file</span>
          <div className="flex flex-wrap gap-2">
            <AttachmentCard
              attachment={{ path, kind: writeAttachmentKind(path, message)! }}
            />
          </div>
        </div>
      )}
      {message.result !== undefined && variant === "read" && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">content</span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">{truncate(message.result, 800)}</pre>
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
      onSelect={onSelect}
      selected={selected}
      turnEpoch={turnEpoch}
    />
  );
}

/**
 * For Write tool calls, return the attachment kind iff the file
 * looks like a recognisable artifact (image / md / html) and the
 * call didn't fail. `null` means "render no attachment card",
 * keeping the existing behavior for source files.
 */
function writeAttachmentKind(
  path: string,
  message: ToolMessage,
): "image" | "markdown" | "html" | null {
  if (message.error) return null;
  if (message.status !== "succeeded") return null;
  const k = classifyPath(path);
  if (k === "file") return null;
  return k;
}
