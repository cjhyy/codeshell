import React, { useId, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { useCopyFeedback } from "../ui/useCopyFeedback";
import { useToast } from "../ui/ToastProvider";

const PREVIEW_CHARACTERS = 2_000;
const PREVIEW_LINES = 24;

interface Props {
  label: string;
  text: string;
  tone?: "default" | "error" | "added";
  /** Colorize only the visible text, without changing the source used to copy. */
  renderText?: (text: string) => React.ReactNode;
}

/** Full output stays reachable without mounting an unbounded initial preview. */
export function ToolOutputBlock({ label, text, tone = "default", renderText }: Props) {
  const { t } = useT();
  const toast = useToast();
  const { copied, copy } = useCopyFeedback(text);
  const [expanded, setExpanded] = useState(false);
  const outputId = useId();
  const labelId = useId();
  let preview = text.slice(0, PREVIEW_CHARACTERS).split("\n").slice(0, PREVIEW_LINES).join("\n");
  // A preview boundary must not leave half of an emoji's surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  const truncated = preview.length < text.length;
  const visibleText = expanded ? text : preview;

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1" data-tool-output={label}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span
          id={labelId}
          className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground"
        >
          {label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 rounded-md text-muted-foreground"
          aria-label={`${t(copied ? "msg.assistant.copied" : "msg.toolOutput.copy")} · ${label}`}
          title={t(copied ? "msg.assistant.copied" : "msg.toolOutput.copy")}
          onClick={async (event) => {
            event.stopPropagation();
            if (!(await copy(text))) toast({ message: t("msg.copyFailed"), variant: "error" });
          }}
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        </Button>
      </div>
      <pre
        id={outputId}
        tabIndex={0}
        aria-labelledby={labelId}
        className={cn(
          "m-0 max-h-64 min-w-0 max-w-full overflow-auto overscroll-contain whitespace-pre-wrap rounded-md p-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          tone === "error"
            ? "bg-status-err/10 text-status-err"
            : tone === "added"
              ? "bg-status-ok/10 text-status-ok"
              : "bg-muted/40",
        )}
      >
        {text.length === 0 ? (
          <span className="font-sans text-muted-foreground">{t("msg.toolOutput.empty")}</span>
        ) : renderText ? (
          renderText(visibleText)
        ) : (
          visibleText
        )}
      </pre>
      {truncated && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
          <span className="text-[11px] text-muted-foreground">
            {!expanded && t("msg.toolOutput.preview")}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 rounded-md px-1.5 text-[11px] text-primary"
            aria-expanded={expanded}
            aria-controls={outputId}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((current) => !current);
            }}
          >
            {t(expanded ? "msg.toolOutput.collapse" : "msg.toolOutput.expand")}
          </Button>
        </div>
      )}
    </div>
  );
}
