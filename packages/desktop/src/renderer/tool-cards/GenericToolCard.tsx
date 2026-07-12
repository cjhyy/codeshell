import React, { useState } from "react";
import type { ToolMessage } from "../types";
import { ToolCardShell } from "./ToolCardShell";
import { SandboxBadge } from "./SandboxBadge";
import { parsedArgs, truncate } from "./utils";
import { detectAttachments } from "./attachments";
import { AttachmentCard } from "./AttachmentCard";
import { Lightbox } from "../chat/Lightbox";
import { driveAgentLinkDetailForToolMessage } from "../cc-room/driveAgentLink";
import { DriveAgentLinkButton } from "../cc-room/DriveAgentLinkButton";
import { useDriveAgentJobs } from "./DriveAgentJobsContext";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  turnEpoch?: number;
  /** Session cwd, used to resolve relative attachment paths. */
  cwd?: string | null;
}

export function GenericToolCard({ message, onSelect, selected, turnEpoch, cwd }: Props) {
  const backgroundJobs = useDriveAgentJobs();
  const cliLink = driveAgentLinkDetailForToolMessage(message, backgroundJobs);
  // Use parsedArgs (argsLive ?? parsed message.args), NOT raw message.args —
  // message.args is the tool_use_start snapshot ("{}" while streaming); the real
  // args arrive via tool_use_args_delta and live in argsLive. Reading the raw
  // string made every tool falling through to this generic card (DriveAgent,
  // etc.) show args as "{}" in live view. parsedArgs covers replay too (no
  // argsLive → parse the persisted args string).
  const args = parsedArgs(message);
  const argsJson = JSON.stringify(args);
  const oneLine = summarizeArgs(args);
  const attachments = detectAttachments(message.toolName, argsJson, message.result);
  // Screenshots / images the tool returned (browser_observe vision/image,
  // view_image). Click a thumbnail to zoom via the shared Lightbox.
  const images = message.images ?? [];
  const [zoom, setZoom] = useState<number | null>(null);
  const imgSrc = (i: number) => `data:${images[i]!.mediaType};base64,${images[i]!.data}`;

  const summary = <span className="text-muted-foreground">{oneLine}</span>;

  const details = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
          args
        </span>
        <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">
          {JSON.stringify(args, null, 2)}
        </pre>
      </div>
      {message.result !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
            result
          </span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-xs">
            {truncate(message.result, 1500)}
          </pre>
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
            screenshot
          </span>
          <div className="flex flex-wrap gap-2">
            {images.map((_, i) => (
              <button
                key={i}
                type="button"
                className="overflow-hidden rounded-sm border border-border bg-muted/40 transition hover:border-primary"
                onClick={() => setZoom(i)}
                title="点击放大"
              >
                <img
                  src={imgSrc(i)}
                  alt={`screenshot ${i + 1}`}
                  className="block max-h-40 max-w-[12rem] object-contain"
                />
              </button>
            ))}
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
            files
          </span>
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentCard key={a.path} attachment={a} cwd={cwd} />
            ))}
          </div>
        </div>
      )}
      {message.error && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
            error
          </span>
          <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-status-err/10 p-2 font-mono text-xs text-status-err">
            {message.error}
          </pre>
        </div>
      )}
    </div>
  );

  return (
    <>
      <ToolCardShell
        message={message}
        summary={summary}
        details={details}
        headerBadge={message.sandbox && <SandboxBadge sandbox={message.sandbox} />}
        headerAction={cliLink && <DriveAgentLinkButton detail={cliLink} />}
        onSelect={onSelect}
        selected={selected}
        turnEpoch={turnEpoch}
      />
      {zoom !== null && images[zoom] && (
        <Lightbox
          src={imgSrc(zoom)}
          alt={`screenshot ${zoom + 1}`}
          onClose={() => setZoom(null)}
          items={images.map((_, i) => ({ src: imgSrc(i), alt: `screenshot ${i + 1}` }))}
          index={zoom}
        />
      )}
    </>
  );
}

function summarizeArgs(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  const preferred = ["command", "file_path", "url", "path", "pattern", "query", "task", "prompt"];
  for (const key of preferred) {
    if (typeof obj[key] === "string") return truncate(obj[key] as string, 80);
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string") return truncate(v, 80);
  }
  return keys.join(", ");
}
