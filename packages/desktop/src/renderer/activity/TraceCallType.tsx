import React from "react";
import type { ModelTraceCallType } from "../../preload/model-trace-api";
import { useT, type TFunction } from "../i18n/I18nProvider";

export const TRACE_CALL_TYPES: readonly ModelTraceCallType[] = [
  "execution",
  "task",
  "panel",
  "summary",
  "context",
  "title",
  "goal",
  "memory",
  "suggestion",
  "speech",
  "transcription",
  "audio",
  "external",
  "other",
];

export function traceCallTypeLabel(type: ModelTraceCallType | undefined, t: TFunction): string {
  return t(`observability.type_${type && TRACE_CALL_TYPES.includes(type) ? type : "other"}`);
}

export function traceCallTypeDescription(
  type: ModelTraceCallType | undefined,
  t: TFunction,
): string {
  return t(`observability.typeHint_${type && TRACE_CALL_TYPES.includes(type) ? type : "other"}`);
}

export function isMediaModelCall(type: ModelTraceCallType | undefined): boolean {
  return type === "speech" || type === "transcription" || type === "audio";
}

export function TraceCallTypeBadge({ type }: { type?: ModelTraceCallType }) {
  const { t } = useT();
  return (
    <span
      data-trace-call-type={type && TRACE_CALL_TYPES.includes(type) ? type : "other"}
      title={traceCallTypeDescription(type, t)}
      className="inline-flex max-w-full rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-foreground [overflow-wrap:anywhere]"
    >
      {traceCallTypeLabel(type, t)}
    </span>
  );
}
