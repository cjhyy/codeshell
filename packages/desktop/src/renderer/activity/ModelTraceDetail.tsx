import React, { useEffect, useRef, useState } from "react";
import type { ModelTraceRecord, ModelTraceEvent } from "../../preload/model-trace-api";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { TraceContentNotice, TraceMessages, TracePayload } from "./TracePayload";
import {
  traceDuration,
  traceTime,
  traceStatusLabel,
  traceCoverageLabel,
} from "./modelTracePresentation";

export type TraceSelection =
  | { kind: "request" }
  | { kind: "attempt"; id: string }
  | { kind: "event"; id: string };

export function ModelTraceDetail({
  record,
  events,
  selection,
  onOpenSession,
}: {
  record: ModelTraceRecord;
  events: ModelTraceEvent[];
  selection: TraceSelection;
  onOpenSession?: (id: string) => void | boolean | Promise<void | boolean>;
}) {
  const { t, lang } = useT();
  const [tab, setTab] = useState<"input" | "output" | "raw">("input");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openingVersion = useRef(0);
  const openingRef = useRef(false);
  useEffect(() => {
    openingVersion.current++;
    openingRef.current = false;
    setOpening(false);
    setOpenError(null);
    return () => {
      openingVersion.current++;
    };
  }, [record.id]);
  const attempt =
    selection.kind === "attempt"
      ? record.attempts.find((item) => item.id === selection.id)
      : undefined;
  const event =
    selection.kind === "event" ? events.find((item) => item.id === selection.id) : undefined;
  const selected = attempt ?? event ?? record;
  const isEvent = !!event;
  const title = attempt
    ? t("observability.attempt", { number: attempt.number })
    : (event?.name ?? record.model);
  const firstTokenAt = attempt
    ? attempt.firstTokenAt
    : isEvent
      ? undefined
      : record.attempts.find((item) => item.firstTokenAt !== undefined)?.firstTokenAt;
  const firstTokenStart = attempt ? attempt.startedAt : record.startedAt;
  const usage = attempt ? attempt.usage : isEvent ? undefined : record.usage;
  const output = attempt ? attempt.output : isEvent ? undefined : record.output;
  const external =
    record.source.includes("external-cli") ||
    record.attempts.some((item) => item.coverage === "external-cli-input");
  const coverage =
    attempt?.coverage ??
    (record.attempts.some((item) => item.coverage === "provider-wire")
      ? "provider-wire"
      : external
        ? "external-cli-input"
        : "logical-input");
  const cost = attempt ? attempt.estimatedCostUsd : isEvent ? undefined : record.estimatedCostUsd;
  const unknownCostAttempts = attempt || isEvent ? 0 : (record.unknownCostAttempts ?? 0);
  const costLabel =
    cost !== null && cost !== undefined && Number.isFinite(cost)
      ? `~$${cost.toFixed(6)}${unknownCostAttempts ? ` · ${t("observability.partialCost", { count: unknownCostAttempts })}` : ""}`
      : t("observability.costUnknown");
  const canShowInput = selected.inputState !== "not-recorded";
  const canShowOutput = selected.outputState !== "not-recorded";
  return (
    <div className="min-w-0 space-y-4 p-4" data-trace-detail-id={selected.id}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">
            {event
              ? t(
                  `observability.kind${event.kind === "tool" ? "Tool" : event.kind === "approval" ? "Approval" : "Lifecycle"}`,
                )
              : record.provider}
          </p>
          <h2 className="mt-1 break-words text-base font-semibold [overflow-wrap:anywhere]">
            {title}
          </h2>
          <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
            {selected.id}
          </p>
        </div>
        {onOpenSession && record.sessionId && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={opening}
            onClick={() => {
              if (openingRef.current) return;
              openingRef.current = true;
              const version = ++openingVersion.current;
              setOpening(true);
              setOpenError(null);
              void Promise.resolve()
                .then(() => onOpenSession(record.sessionId!))
                .then((result) => {
                  if (result === false) throw new Error(t("observability.missing"));
                })
                .catch((error) => {
                  if (version === openingVersion.current) setOpenError(String(error));
                })
                .finally(() => {
                  if (version === openingVersion.current) {
                    openingRef.current = false;
                    setOpening(false);
                  }
                });
            }}
          >
            {t("observability.openSession")}
          </Button>
        )}
      </div>
      {openError && (
        <p role="alert" className="break-words text-xs text-status-err">
          {t("observability.openError", { error: openError })}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted/30 p-3 text-xs @min-[500px]/trace-detail:grid-cols-3">
        {[
          [t("observability.status"), traceStatusLabel(selected.status, t)],
          [t("observability.duration"), traceDuration(selected.startedAt, selected.endedAt)],
          [t("observability.ttft"), traceDuration(firstTokenStart, firstTokenAt)],
          [t("observability.tokens"), usage?.totalTokens.toLocaleString() ?? "—"],
          [
            t("observability.inputOutput"),
            usage
              ? `${usage.promptTokens.toLocaleString()} / ${usage.completionTokens.toLocaleString()}`
              : "—",
          ],
          [t("observability.cost"), costLabel],
          [
            t("observability.cache"),
            usage ? `${usage.cacheReadTokens ?? "—"} / ${usage.cacheCreationTokens ?? "—"}` : "—",
          ],
          [t("observability.started"), traceTime(selected.startedAt, lang)],
          [t("observability.ended"), traceTime(selected.endedAt, lang)],
          ...(attempt?.httpStatus !== undefined
            ? [[t("observability.http"), String(attempt.httpStatus)]]
            : []),
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words font-medium tabular-nums [overflow-wrap:anywhere]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {!isEvent && (
        <div className="space-y-1 rounded-lg border border-border/70 p-3 text-xs text-muted-foreground">
          <p>
            {coverage === "external-cli-input"
              ? t("observability.externalInput")
              : t(
                  coverage === "provider-wire"
                    ? "observability.wireCoverage"
                    : "observability.logicalCoverage",
                )}
          </p>
          {external && <p className="leading-relaxed">{t("observability.externalCoverage")}</p>}
        </div>
      )}
      {selected.error && (
        <TracePayload title={t("observability.error")} value={selected.error} text />
      )}
      <div
        className="flex flex-wrap gap-1 border-b border-border/70 pb-2"
        aria-label={t("observability.details")}
      >
        {(["input", "output", "raw"] as const).map((key) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={tab === key ? "secondary" : "ghost"}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {t(`observability.${key}`)}
          </Button>
        ))}
      </div>
      {tab === "raw" ? (
        <TracePayload title={t("observability.raw")} value={selected} />
      ) : tab === "input" ? (
        <section className="min-w-0 space-y-3" aria-label={t("observability.input")}>
          <TraceContentNotice state={selected.inputState} />
          {canShowInput &&
            (attempt || event ? (
              <TracePayload
                title={attempt ? traceCoverageLabel(attempt.coverage, t) : t("observability.input")}
                value={selected.input}
              />
            ) : record.input ? (
              <>
                <TracePayload
                  title={t("observability.system")}
                  value={record.input.systemPrompt}
                  text
                />
                <TraceMessages messages={record.input.messages} />
                <TracePayload title={t("observability.tools")} value={record.input.tools} />
                <TracePayload
                  title={t("observability.parameters")}
                  value={record.input.parameters}
                />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t("observability.noContent")}</p>
            ))}
        </section>
      ) : (
        <section className="min-w-0 space-y-3" aria-label={t("observability.output")}>
          <TraceContentNotice state={selected.outputState} />
          {canShowOutput &&
            (event ? (
              <TracePayload
                title={t("observability.output")}
                value={event.output}
                text={typeof event.output === "string"}
              />
            ) : output ? (
              <>
                {output.text !== undefined && (
                  <TracePayload title={t("observability.text")} value={output.text} text />
                )}
                {output.thinking !== undefined && (
                  <TracePayload title={t("observability.thinking")} value={output.thinking} text />
                )}
                {output.toolCalls && (
                  <TracePayload title={t("observability.toolCalls")} value={output.toolCalls} />
                )}
                {output.data !== undefined && (
                  <TracePayload title={t("observability.output")} value={output.data} />
                )}
                {output.stopReason && (
                  <TracePayload
                    title={t("observability.stopReason")}
                    value={output.stopReason}
                    text
                  />
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t("observability.noContent")}</p>
            ))}
        </section>
      )}
    </div>
  );
}
