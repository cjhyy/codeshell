import type { PetDispatchResult, PetOpenSessionRequest } from "../../preload/types";
import React from "react";
import { ChatView } from "../ChatView";
import type { ModelOption } from "../chat/ModelPill";
import { useT } from "../i18n";
import { PetActionChip } from "./PetActionChip";
import { PET_CHAT_BUCKET, usePetState } from "./PetStateProvider";

export function PetChatHost({
  modelOptions,
  defaultModelKey,
  onNavigate,
}: {
  modelOptions: ModelOption[];
  defaultModelKey: string | null;
  onNavigate: (target: PetOpenSessionRequest) => void;
}) {
  const { t } = useT();
  const {
    state,
    dispatch,
    petSessionId,
    chatState,
    chatDispatch,
    chatBusy,
    setChatBusy,
    chatModelKey,
    setChatModelKey,
  } = usePetState();
  const [deterministic, setDeterministic] = React.useState<PetDispatchResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const activeModelKey = chatModelKey ?? defaultModelKey;

  React.useEffect(() => {
    if (!chatModelKey && defaultModelKey) setChatModelKey(defaultModelKey);
  }, [chatModelKey, defaultModelKey, setChatModelKey]);

  const send = async (text: string): Promise<void> => {
    const message = text.trim();
    if (!message || !petSessionId) return;
    const clientMessageId = `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    chatDispatch({
      type: "user_message",
      bucket: PET_CHAT_BUCKET,
      text: message,
      clientMessageId,
    });
    setChatBusy(true);
    setError(null);
    try {
      const result = await window.codeshell.pet.dispatch({ type: "chat", message });
      if (!result.ok) setError(result.message ?? t("pet.chat.failed"));
    } catch (dispatchError) {
      setError(dispatchError instanceof Error ? dispatchError.message : t("pet.chat.failed"));
    } finally {
      setChatBusy(false);
    }
  };

  const runDeterministic = async (type: "get_global_status" | "list_pending") => {
    const result = await window.codeshell.pet.dispatch({ type });
    setDeterministic(result);
  };

  const actions = React.useMemo(() => {
    if (!deterministic?.ok || !state.projection) return [];
    if (deterministic.type === "global_status") {
      return deterministic.sessions.map((session) => ({
        label: session.title ?? session.agentSessionId.slice(-8),
        target: {
          agentSessionId: session.agentSessionId,
          snapshotVersion: deterministic.version,
          generation: deterministic.generation,
        },
      }));
    }
    if (deterministic.type === "pending_list") {
      return deterministic.pending.map((pending) => ({
        label: pending.title,
        target: {
          agentSessionId: pending.agentSessionId,
          snapshotVersion: state.projection!.version,
          generation: state.projection!.generation,
          requestId: pending.requestId,
          routeGeneration: pending.routeGeneration,
        },
      }));
    }
    return [];
  }, [deterministic, state.projection]);

  if (!petSessionId) {
    return (
      <section className="flex min-h-0 items-center justify-center p-4 text-sm text-muted-foreground">
        {t("pet.chat.loading")}
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden" aria-label={t("pet.chat.title")}>
      <div className="flex flex-wrap gap-1.5 border-b border-border p-2">
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          onClick={() => void runDeterministic("get_global_status")}
        >
          {t("pet.chat.globalStatus")}
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          onClick={() => void runDeterministic("list_pending")}
        >
          {t("pet.chat.listPending")}
        </button>
        {actions.map((action) => (
          <PetActionChip
            key={`${action.target.agentSessionId}:${action.label}`}
            label={action.label}
            target={action.target}
            onOpen={onNavigate}
          />
        ))}
      </div>
      {error && (
        <p className="border-b border-border px-3 py-1 text-xs text-status-err" role="status">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <ChatView
          variant="pet"
          messages={chatState.messages}
          turnEpoch={chatState.turnEpoch}
          engineSessionId={petSessionId}
          liveTurnActive={chatBusy}
          onSend={(text) => void send(text)}
          onStop={() => void window.codeshell.cancel(petSessionId)}
          busy={chatBusy}
          activeProjectId={null}
          permissionMode="default"
          onPermissionChange={() => undefined}
          goalEnabled={false}
          onGoalToggle={() => undefined}
          modelOptions={modelOptions}
          activeModelKey={activeModelKey}
          onModelChange={(option) => {
            setChatModelKey(option.key);
            void window.codeshell.configure({ sessionId: petSessionId, model: option.key });
          }}
          contextTokens={chatState.promptTokens}
          singleTurnPromptTokens={chatState.singleTurnPromptTokens}
          singleTurnCacheReadTokens={chatState.singleTurnCacheReadTokens}
          singleTurnCacheCreationTokens={chatState.singleTurnCacheCreationTokens}
          cumulativePromptTokens={chatState.cumulativePromptTokens}
          cumulativeCacheReadTokens={chatState.cumulativeCacheReadTokens}
          cumulativeCacheCreationTokens={chatState.cumulativeCacheCreationTokens}
          projects={[]}
          onSelectProject={() => undefined}
          onAddProject={() => undefined}
          activeProjectPath={null}
          messageCwd={null}
          draft={state.chatDraft}
          onDraftChange={(next) =>
            dispatch({
              type: "set-chat-draft",
              draft: typeof next === "function" ? next(state.chatDraft) : next,
            })
          }
          attachments={[]}
          onAttachmentsChange={() => undefined}
        />
      </div>
    </section>
  );
}
