import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ModelTraceContentState } from "../../preload/model-trace-api";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useCopyFeedback } from "../ui/useCopyFeedback";

export function TraceContentNotice({ state }: { state: ModelTraceContentState }) {
  const { t } = useT();
  if (state === "recorded") return null;
  return (
    <p
      role="status"
      className="rounded-lg border border-border/70 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground"
    >
      {t(
        state === "not-recorded"
          ? "observability.notRecorded"
          : state === "truncated"
            ? "observability.truncated"
            : "observability.redacted",
      )}
      {state === "not-recorded" && (
        <span className="mt-1 block">{t("observability.notRecordedHint")}</span>
      )}
    </p>
  );
}

export function TracePayload({
  title,
  value,
  text = false,
}: {
  title: string;
  value: unknown;
  text?: boolean;
}) {
  const { t } = useT();
  const serialized =
    typeof value === "string" && text ? value : JSON.stringify(value ?? null, null, 2);
  const { copied, copy } = useCopyFeedback(serialized);
  const [failed, setFailed] = useState(false);
  return (
    <details open className="min-w-0 rounded-xl border border-border/70 bg-card">
      <summary className="cursor-pointer break-words px-3 py-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {title}
      </summary>
      <div className="min-w-0 border-t border-border/60 p-3">
        <div className="mb-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => void copy(serialized).then((success) => setFailed(!success))}
            aria-label={`${t(text ? "observability.copyText" : "observability.copy")} · ${title}`}
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {t(
              copied
                ? "observability.copied"
                : text
                  ? "observability.copyText"
                  : "observability.copy",
            )}
          </Button>
        </div>
        {failed && (
          <p role="alert" className="mb-2 text-xs text-status-err">
            {t("observability.copyFailed")}
          </p>
        )}
        <pre
          tabIndex={0}
          aria-label={title}
          className="m-0 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
        >
          {serialized || t("observability.noContent")}
        </pre>
      </div>
    </details>
  );
}

export function TraceMessages({ messages }: { messages: unknown[] }) {
  const { t } = useT();
  return (
    <section aria-label={t("observability.messages")} className="min-w-0 space-y-2">
      {messages.map((value, index) => {
        const message =
          value && typeof value === "object" ? (value as Record<string, unknown>) : null;
        return (
          <TracePayload
            key={index}
            title={`${index + 1} · ${typeof message?.role === "string" ? message.role : t("observability.messages")}`}
            value={message?.content ?? value}
            text={typeof message?.content === "string"}
          />
        );
      })}
      <TracePayload title={`${t("observability.messages")} JSON`} value={messages} />
    </section>
  );
}
