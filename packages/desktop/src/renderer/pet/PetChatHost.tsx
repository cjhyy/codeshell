import React from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import dogIcon from "../assets/codeshell-dog-icon.png";
import type { Message } from "../types";
import { useT } from "../i18n";
import { visiblePetAssistantText } from "./petChatRouting";
import { PET_CHAT_BUCKET, usePetState } from "./PetStateProvider";

interface PetChatRow {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function selectPetChatRows(messages: readonly Message[]): PetChatRow[] {
  return messages.flatMap<PetChatRow>((message) => {
    if (message.kind === "user" && message.text.trim()) {
      return [{ id: message.id, role: "user" as const, text: message.text.trim() }];
    }
    if (message.kind === "assistant") {
      const text = visiblePetAssistantText(message.text);
      return text ? [{ id: message.id, role: "assistant" as const, text }] : [];
    }
    return [];
  });
}

export function PetChatHost({ defaultProjectId }: { defaultProjectId: string | null }) {
  const { t } = useT();
  const { state, dispatch, petSessionId, chatState, chatDispatch, chatBusy, setChatBusy } =
    usePetState();
  const [error, setError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const rows = React.useMemo(() => selectPetChatRows(chatState.messages), [chatState.messages]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chatBusy, rows.length, rows.at(-1)?.text]);

  const setDraft = (draft: string): void => dispatch({ type: "set-chat-draft", draft });

  const submitToPet = async (): Promise<void> => {
    const message = state.chatDraft.trim();
    if (!message || !petSessionId || chatBusy) return;
    const clientMessageId = `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setDraft("");
    setError(null);
    chatDispatch({
      type: "user_message",
      bucket: PET_CHAT_BUCKET,
      text: message,
      clientMessageId,
    });
    setChatBusy(true);
    try {
      const result = await window.codeshell.pet.dispatch({
        type: "chat",
        message,
        clientMessageId,
        ...(defaultProjectId ? { preferredProjectId: defaultProjectId } : {}),
      });
      if (!result.ok) setError(result.message ?? t("pet.chat.failed"));
    } catch (dispatchError) {
      setError(dispatchError instanceof Error ? dispatchError.message : t("pet.chat.failed"));
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <section
      className="mimi-surface flex min-h-[520px] flex-col overflow-hidden rounded-3xl min-[1100px]:min-h-0"
      aria-label={t("pet.chat.title")}
      data-pet-manager-chat="true"
      data-pet-auto-routing="true"
    >
      <div className="flex items-center gap-3 border-b border-border/55 px-5 py-4 min-[1440px]:px-6 min-[1440px]:py-5">
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
          <img
            src={dogIcon}
            alt=""
            draggable={false}
            className="h-9 w-9 select-none object-contain"
          />
          <span
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-status-ok"
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t("pet.chat.managerTitle")}</div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{t("pet.chat.subtitle")}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/15 px-4 py-5 min-[1440px]:px-5">
        {rows.length === 0 ? (
          <div className="flex h-full min-h-56 items-center justify-center px-5 text-center">
            <div className="max-w-xs">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl border border-primary/10 bg-primary/8 shadow-sm">
                <img
                  src={dogIcon}
                  alt=""
                  draggable={false}
                  className="h-14 w-14 select-none object-contain"
                />
              </div>
              <h3 className="text-base font-semibold tracking-tight">{t("pet.chat.emptyTitle")}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {petSessionId ? t("pet.chat.empty") : t("pet.chat.loading")}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3.5">
            {rows.map((row) =>
              row.role === "user" ? (
                <div key={row.id} className="flex justify-end pl-10">
                  <div className="max-w-[88%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm">
                    <div className="whitespace-pre-wrap break-words">{row.text}</div>
                  </div>
                </div>
              ) : (
                <div key={row.id} className="flex items-start gap-2.5 pr-6">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                    <img
                      src={dogIcon}
                      alt=""
                      draggable={false}
                      className="h-6 w-6 select-none object-contain"
                    />
                  </span>
                  <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-border/60 bg-background px-3.5 py-2.5 text-sm leading-6 shadow-sm">
                    <div className="whitespace-pre-wrap break-words">{row.text}</div>
                  </div>
                </div>
              ),
            )}
            {chatBusy && (
              <div className="flex items-start gap-2.5 pr-6">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                  <img
                    src={dogIcon}
                    alt=""
                    draggable={false}
                    className="h-6 w-6 select-none object-contain"
                  />
                </span>
                <div className="rounded-2xl rounded-tl-md border border-border/60 bg-background px-3.5 py-2.5 text-xs text-muted-foreground shadow-sm">
                  {t("pet.chat.organizing")}
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {error && (
        <p
          className="mx-4 rounded-xl bg-status-err/10 px-3 py-2 text-xs text-status-err"
          role="status"
        >
          {error}
        </p>
      )}

      <div className="shrink-0 p-4 pt-2 min-[1440px]:p-5 min-[1440px]:pt-3">
        <div className="rounded-2xl border border-input/90 bg-background p-2 shadow-[0_8px_24px_hsl(var(--cs-foreground)/0.06)] transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
          <textarea
            value={state.chatDraft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              void submitToPet();
            }}
            rows={2}
            className="w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground/75"
            placeholder={t("pet.chat.placeholder")}
            aria-label={t("pet.chat.placeholder")}
            disabled={!petSessionId || chatBusy}
          />
          <div className="flex items-end justify-between gap-3 px-1 pb-0.5">
            <p className="flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
              <Sparkles size={11} className="shrink-0 text-primary" aria-hidden="true" />
              <span className="line-clamp-2">{t("pet.chat.autoRoute")}</span>
            </p>
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-40"
              disabled={!state.chatDraft.trim() || !petSessionId || chatBusy}
              onClick={() => void submitToPet()}
            >
              <ArrowUp size={13} aria-hidden="true" />
              {t("pet.chat.send")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
