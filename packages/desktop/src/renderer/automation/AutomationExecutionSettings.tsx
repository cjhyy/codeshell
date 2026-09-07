import React, { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Link2, Loader2, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import type { TFunction } from "../i18n/I18nProvider";
import type { AutomationConversation } from "./sessionOptions";

export function AutomationExecutionSettings({
  resumeSessionId,
  conversations,
  busy,
  error,
  onClearError,
  loading = false,
  onRefresh,
  onLoadMore,
  t,
  onSave,
  onOpen,
}: {
  resumeSessionId: string | null;
  /** Includes archived conversations for displaying an existing binding. */
  conversations: AutomationConversation[];
  busy: boolean;
  error?: string | null;
  onClearError?: () => void;
  loading?: boolean;
  onRefresh?: () => void;
  onLoadMore?: () => void;
  t: TFunction;
  onSave: (patch: { resumeSessionId: string | null }) => void | Promise<unknown>;
  onOpen: (conversation: AutomationConversation) => void;
}) {
  const [mode, setMode] = useState<"fresh" | "resume">(resumeSessionId ? "resume" : "fresh");
  const [selectedId, setSelectedId] = useState(resumeSessionId ?? "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const reset = () => {
    onClearError?.();
    setMode(resumeSessionId ? "resume" : "fresh");
    setSelectedId(resumeSessionId ?? "");
  };
  useEffect(reset, [resumeSessionId]);

  const disabled = busy || saving;
  const selected = conversations.find((conversation) => conversation.sessionId === selectedId);
  const choices = conversations.filter(
    (conversation) => !conversation.archived || conversation.sessionId === resumeSessionId,
  );
  const nextId = mode === "resume" ? selectedId : null;
  const dirty = mode !== (resumeSessionId ? "resume" : "fresh") || nextId !== resumeSessionId;
  const valid = mode === "fresh" || (!!selected && choices.includes(selected));
  const save = async () => {
    if (disabled || savingRef.current || !dirty || !valid) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave({ resumeSessionId: nextId });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section
      aria-label={t("auto.detail.executionMode")}
      className="min-w-0 rounded-2xl border border-border/70 bg-card p-4"
    >
      <h3 className="text-sm font-semibold text-foreground">{t("auto.detail.executionMode")}</h3>
      <div className="mt-3 grid min-w-0 gap-2 @min-[520px]/automation-detail:grid-cols-2">
        {(["fresh", "resume"] as const).map((value) => {
          const active = mode === value;
          const Icon = value === "fresh" ? MessageSquarePlus : Link2;
          return (
            <Button
              key={value}
              type="button"
              variant="outline"
              aria-label={t(value === "fresh" ? "auto.detail.freshMode" : "auto.detail.resumeMode")}
              aria-pressed={active}
              disabled={disabled}
              className={cn(
                "h-auto min-w-0 items-start justify-start gap-2.5 whitespace-normal rounded-xl p-3 text-left",
                active && "border-primary/40 bg-primary/5 hover:bg-primary/10",
              )}
              onClick={() => {
                onClearError?.();
                setMode(value);
              }}
            >
              <Icon
                size={17}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {t(value === "fresh" ? "auto.detail.freshMode" : "auto.detail.resumeMode")}
                </span>
                <span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">
                  {t(value === "fresh" ? "auto.detail.freshHint" : "auto.detail.resumeHint")}
                </span>
              </span>
              {active && (
                <Check size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
              )}
            </Button>
          );
        })}
      </div>

      {mode === "resume" && (
        <div className="mt-4 min-w-0 space-y-2.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t("auto.detail.boundConversation")}
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Combobox
              ariaLabel={t("auto.detail.boundConversation")}
              value={selectedId}
              options={choices.map((conversation) => ({
                value: conversation.sessionId,
                label: conversation.title || t("auto.detail.untitled"),
                hint: conversation.projectLabel,
              }))}
              onChange={(value) => {
                onClearError?.();
                setSelectedId(value);
              }}
              disabled={disabled}
              placeholder={
                selectedId && !selected
                  ? t("auto.detail.conversationUnavailable")
                  : t("auto.detail.chooseConversation")
              }
              searchPlaceholder={t("auto.detail.conversationSearch")}
              emptyText={t("auto.detail.conversationNoMatch")}
              triggerClassName="h-10 min-w-0 flex-1 basis-52 rounded-xl"
            />
            {selected && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 gap-1 text-primary"
                disabled={selected.archived}
                onClick={() => onOpen(selected)}
              >
                {t("auto.detail.openConversation")}
                <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
          {selected && (
            <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {selected.projectLabel} ·{" "}
              {t("auto.detail.conversationUpdated", {
                time: new Date(selected.updatedAt).toLocaleString(),
              })}
            </p>
          )}
          {selected?.archived && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("auto.detail.boundArchived")}
            </p>
          )}
          {selectedId && !selected ? (
            <p role="status" className="text-xs leading-relaxed text-status-warn">
              {t("auto.detail.boundNotFound")}
            </p>
          ) : choices.length === 0 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("auto.detail.noConversations")}
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("auto.detail.resumeContextHint")}
          </p>
          {(onRefresh || onLoadMore) && (
            <div className="flex flex-wrap items-center gap-2">
              {onRefresh && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loading || disabled}
                  onClick={onRefresh}
                >
                  {loading && <Loader2 size={13} aria-hidden="true" className="animate-spin" />}
                  {t("auto.detail.refreshConversations")}
                </Button>
              )}
              {onLoadMore && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loading || disabled}
                  onClick={onLoadMore}
                >
                  {t("auto.detail.moreConversations")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 break-words rounded-xl border border-status-err/20 bg-status-err/5 p-3 text-sm text-status-err [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {dirty && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
          <p className="min-w-0 flex-1 basis-full text-xs text-muted-foreground">
            {t("auto.detail.executionUnsaved")}
          </p>
          <Button type="button" size="sm" disabled={disabled || !valid} onClick={() => void save()}>
            {saving && <Loader2 size={14} aria-hidden="true" className="animate-spin" />}
            {t(saving ? "auto.detail.saving" : "auto.detail.saveExecution")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={reset}>
            {t("auto.detail.cancel")}
          </Button>
        </div>
      )}
    </section>
  );
}
