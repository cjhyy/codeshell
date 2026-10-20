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

export function TraceCallTypeFilter({
  value,
  onChange,
}: {
  value: ModelTraceCallType | "";
  onChange: (value: ModelTraceCallType | "") => void;
}) {
  const { t } = useT();
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{t("observability.callType")}</p>
      <div
        role="group"
        aria-label={t("observability.callType")}
        className="flex max-w-full gap-2 overflow-x-auto overscroll-x-contain pb-1"
      >
        {(["", ...TRACE_CALL_TYPES] as const).map((type) => (
          <button
            key={type}
            type="button"
            data-trace-type-filter={type}
            aria-pressed={value === type}
            title={type ? traceCallTypeDescription(type, t) : undefined}
            onFocus={(event) => {
              // Native Tab scrolling can leave the last chip clipped after a resize.
              event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
            onClick={() => {
              if (type !== value) onChange(type);
            }}
            className={`min-h-9 shrink-0 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              value === type
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {type ? traceCallTypeLabel(type, t) : t("observability.allTypes")}
          </button>
        ))}
      </div>
    </div>
  );
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
