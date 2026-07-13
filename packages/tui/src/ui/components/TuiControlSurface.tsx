import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AgentClient, OnboardingResult } from "@cjhyy/code-shell-core";
import { asyncAgentRegistry } from "@cjhyy/code-shell-core";
import { Box, Text } from "../../render/index.js";
import { CommandInput } from "./CommandInput.js";
import { AskUserPrompt } from "./AskUserPrompt.js";
import { OnboardingPrompt } from "./OnboardingPrompt.js";
import { ModelSelector, type ModelEntry } from "./ModelSelector.js";
import {
  ModelManager,
  type ArenaParticipantEntry,
  type ProviderManagerEntry,
} from "./ModelManager.js";
import { ProviderModelFlow } from "./ProviderModelFlow.js";
import { SessionPicker, type SessionPickerEntry } from "./SessionPicker.js";
import { getVisibleAgents, MAX_VISIBLE, type DockViewMode } from "./AgentDock.js";
import { chatStore, createEntry } from "../store.js";

export interface ModelManagerState {
  entries: ModelEntry[];
  snapshot: { count: number; fetchedAt: string };
  arenaParticipants: ArenaParticipantEntry[];
  providers: ProviderManagerEntry[];
}

export interface PendingQuestion {
  requestId: string;
  question: string;
  header?: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
}

interface CommandDef {
  name: string;
  description: string;
  usage?: string;
}

interface TuiControlSurfaceProps {
  client: AgentClient;
  screen: "prompt" | "transcript";
  cursorIdx: number | null;
  showOnboarding: boolean;
  setShowOnboarding: Dispatch<SetStateAction<boolean>>;
  modelManager: ModelManagerState | null;
  setModelManager: Dispatch<SetStateAction<ModelManagerState | null>>;
  modelEntries: ModelEntry[] | null;
  setModelEntries: Dispatch<SetStateAction<ModelEntry[] | null>>;
  sessionEntries: SessionPickerEntry[] | null;
  setSessionEntries: Dispatch<SetStateAction<SessionPickerEntry[] | null>>;
  wizard: "flow" | null;
  setWizard: Dispatch<SetStateAction<"flow" | null>>;
  pendingQuestion: PendingQuestion | null;
  setPendingQuestion: Dispatch<SetStateAction<PendingQuestion | null>>;
  pendingApproval: boolean;
  sessionId: string | undefined;
  sidRef: MutableRefObject<string | undefined>;
  applyModelConfigureResult: (result: unknown, fallbackModel: string) => string;
  addStatus: (status: string) => void;
  refreshModelManagerState: () => Promise<void>;
  handleSlashCommand: (command: string) => void;
  queuedInputs: string[];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  handleSubmit: (input: string) => void;
  commands: CommandDef[];
  isRunning: boolean;
  dockFocusIdx: number | null;
  setDockFocusIdx: Dispatch<SetStateAction<number | null>>;
  viewMode: DockViewMode;
}

/** Bottom-of-screen modal/input router, kept separate from protocol state. */
export function TuiControlSurface(props: TuiControlSurfaceProps) {
  const {
    client,
    screen,
    cursorIdx,
    showOnboarding,
    setShowOnboarding,
    modelManager,
    setModelManager,
    modelEntries,
    setModelEntries,
    sessionEntries,
    setSessionEntries,
    wizard,
    setWizard,
    pendingQuestion,
    setPendingQuestion,
    pendingApproval,
    sessionId,
    sidRef,
    applyModelConfigureResult,
    addStatus,
    refreshModelManagerState,
    handleSlashCommand,
    queuedInputs,
    input,
    setInput,
    handleSubmit,
    commands,
    isRunning,
    dockFocusIdx,
    setDockFocusIdx,
    viewMode,
  } = props;

  if (screen === "transcript") {
    return (
      <Box marginLeft={2}>
        <Text dim>{"Transcript mode · ctrl+o to return · ↑↓ navigate"}</Text>
        {cursorIdx !== null && <Text dim>{` · selected: ${cursorIdx + 1}`}</Text>}
      </Box>
    );
  }

  if (showOnboarding) {
    return (
      <OnboardingPrompt
        existingProviders={(modelManager?.providers ?? []).map((provider) => ({
          key: provider.key,
          label: provider.label ?? provider.key,
          kind: provider.kind as never,
          baseUrl: provider.baseUrl ?? "",
          apiKey: provider.apiKey,
        }))}
        existingModelKeys={(modelManager?.entries ?? []).map((model) => model.key)}
        existingModelIds={(modelManager?.entries ?? []).map((model) => model.model)}
        onComplete={async (result: OnboardingResult) => {
          setShowOnboarding(false);
          setModelManager(null);
          try {
            const response = await client.configure({
              sessionId: sidRef.current ?? sessionId,
              reloadModels: true,
              model: result.key,
            });
            const activeModel = applyModelConfigureResult(response, result.model);
            addStatus(`✓ 配置已保存,已切换到: ${result.key} (${activeModel})`);
          } catch (error) {
            addStatus(
              `✓ 配置已保存 (${result.model})。热加载失败,请重启 code-shell: ${(error as Error).message}`,
            );
          }
        }}
        onCancel={() => {
          setShowOnboarding(false);
          setModelManager(null);
          addStatus("已取消配置。");
        }}
      />
    );
  }

  if (modelEntries) {
    return (
      <ModelSelector
        entries={modelEntries}
        onSelect={async (key) => {
          setModelEntries(null);
          try {
            const result = await client.configure({
              sessionId: sidRef.current ?? sessionId,
              model: key,
            });
            const newModel = applyModelConfigureResult(result, key);
            addStatus(`✓ 切换到: ${key} (${newModel})`);
          } catch (error) {
            addStatus(`切换失败: ${(error as Error).message}`);
          }
        }}
        onCancel={() => setModelEntries(null)}
      />
    );
  }

  if (sessionEntries) {
    return (
      <SessionPicker
        entries={sessionEntries}
        onSelect={(id) => {
          setSessionEntries(null);
          handleSlashCommand(`/resume ${id}`);
        }}
        onCancel={() => setSessionEntries(null)}
      />
    );
  }

  if (wizard === "flow" && modelManager) {
    return (
      <ProviderModelFlow
        existingProviders={modelManager.providers.map((provider) => ({
          key: provider.key,
          label: provider.label ?? provider.key,
          kind: provider.kind as never,
          baseUrl: provider.baseUrl ?? "",
          apiKey: provider.apiKey,
          protocol: provider.protocol as never,
          modelsPath: provider.modelsPath,
        }))}
        existingModelKeys={modelManager.entries.map((model) => model.key)}
        existingModelIds={modelManager.entries.map((model) => model.model)}
        detectedEnvKeys={[]}
        switchToNewModelOnFinish={false}
        onFinish={async (result) => {
          const failures: string[] = [];
          try {
            if (result.addedProvider) {
              await client.query("provider_add", { provider: result.addedProvider } as never);
            }
          } catch (error) {
            failures.push(`provider ${result.addedProvider?.key}: ${(error as Error).message}`);
          }
          for (const model of result.addedModels) {
            try {
              await client.query("model_add", { model } as never);
            } catch (error) {
              failures.push(`model ${model.key}: ${(error as Error).message}`);
            }
          }
          setWizard(null);
          try {
            await client.configure({ sessionId: sidRef.current ?? sessionId, reloadModels: true });
          } catch {
            // Best effort: the refreshed manager below still reports persisted state.
          }
          await refreshModelManagerState();
          if (failures.length > 0) {
            chatStore.update((previous) => [
              ...previous,
              createEntry({ type: "status", reason: `添加部分失败: ${failures.join("; ")}` }),
            ]);
          }
        }}
        onCancel={() => setWizard(null)}
      />
    );
  }

  if (modelManager) {
    return (
      <ModelManager
        entries={modelManager.entries}
        snapshot={modelManager.snapshot}
        arenaParticipants={modelManager.arenaParticipants}
        providers={modelManager.providers}
        onSaveArena={async (list) => {
          await client.query("config_set", "capabilities.arena.participants", list);
          setModelManager((previous) =>
            previous
              ? {
                  ...previous,
                  arenaParticipants: list.map((key) => ({ kind: "key", value: key })),
                }
              : previous,
          );
        }}
        onSwitch={async (key) => {
          const result = await client.configure({
            sessionId: sidRef.current ?? sessionId,
            model: key,
          });
          applyModelConfigureResult(result, key);
          setModelManager((previous) =>
            previous
              ? {
                  ...previous,
                  entries: previous.entries.map((model) => ({ ...model, active: model.key === key })),
                }
              : previous,
          );
        }}
        onSync={async () => {
          const core = await import("@cjhyy/code-shell-core");
          const result = await core.syncOpenRouterCatalog();
          const snapshot = core.getOpenRouterSnapshot();
          setModelManager((previous) =>
            previous
              ? { ...previous, snapshot: { count: snapshot.count, fetchedAt: snapshot.fetchedAt } }
              : previous,
          );
          return result;
        }}
        onOpenFlow={() => setWizard("flow")}
        onRefreshProvider={async (key) => {
          try {
            const result = (await client.query("provider_refresh", { key } as never)) as {
              count?: number;
              error?: string;
            };
            await refreshModelManagerState();
            return {
              count: result?.count ?? 0,
              ...(result?.error ? { error: result.error } : {}),
            };
          } catch (error) {
            return { count: 0, error: (error as Error).message };
          }
        }}
        onDeleteProvider={async (key) => {
          try {
            await client.query("provider_delete", { key } as never);
            await refreshModelManagerState();
            return { ok: true };
          } catch (error) {
            return { ok: false, error: (error as Error).message };
          }
        }}
        onDeleteModel={async (key) => {
          await client.query("model_delete", { key } as never);
          await refreshModelManagerState();
        }}
        onClose={() => setModelManager(null)}
      />
    );
  }

  if (pendingQuestion) {
    return (
      <AskUserPrompt
        question={pendingQuestion.question}
        header={pendingQuestion.header}
        options={pendingQuestion.options}
        multiSelect={pendingQuestion.multiSelect}
        onAnswer={(answer) => {
          const { requestId } = pendingQuestion;
          setPendingQuestion(null);
          client.approve(requestId, { approved: true, answer }).catch(() => {});
        }}
        onCancel={() => {
          const { requestId } = pendingQuestion;
          setPendingQuestion(null);
          client
            .approve(requestId, { approved: false, reason: "(user declined to answer)" })
            .catch(() => {});
        }}
      />
    );
  }

  if (pendingApproval) return null;

  return (
    <>
      {queuedInputs.length > 0 && (
        <Box marginLeft={2}>
          <Text dim>
            {`⌛ 已缓存 ${queuedInputs.length} 条，将在本轮结束后依次发送（/force 立即打断并优先发送）`}
          </Text>
        </Box>
      )}
      <CommandInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        commands={commands}
        placeholder={isRunning ? "Interrupt… (Ctrl+C to cancel)" : undefined}
        disabled={dockFocusIdx !== null}
        onArrowOut={(direction) => {
          if (direction !== "down") return;
          const visible = getVisibleAgents(asyncAgentRegistry.getSnapshot(), Date.now());
          if (visible.length === 0) return;
          if (viewMode.kind === "agent") {
            const index = visible.findIndex((agent) => agent.agentId === viewMode.agentId);
            if (index >= 0 && index < MAX_VISIBLE) {
              setDockFocusIdx(index + 1);
              return;
            }
          }
          setDockFocusIdx(0);
        }}
      />
    </>
  );
}
