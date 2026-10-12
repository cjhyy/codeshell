import React from "react";
import { Loader2 } from "lucide-react";
import { ChatView } from "../ChatView";
import type { TrackedProject } from "../projects";
import { useT } from "../i18n/I18nProvider";
import { Button } from "../components/ui/button";
import { LocalRuntimeActionsContext } from "./RuntimeCapabilities";
import type { CloudProjectRuntimeView } from "./useCloudProjectRuntime";

export interface CloudProjectWorkspaceProps {
  runtime: CloudProjectRuntimeView;
  runLocationControl?: React.ReactNode;
  projects: TrackedProject[];
  activeProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onAddProject: () => void;
}

/** Native desktop conversation surface backed exclusively by the captured cloud connection. */
export function CloudProjectWorkspace({
  runtime,
  runLocationControl,
  ...projects
}: CloudProjectWorkspaceProps) {
  const { lang } = useT();
  const zh = lang === "zh";
  const unavailable = runtime.status !== "connected";
  const models =
    runtime.configuration?.connections
      .filter((connection) => connection.tag === "text")
      .map((connection) => ({
        key: connection.id,
        label: connection.model,
        provider: connection.catalogId,
      })) ?? [];
  return (
    <LocalRuntimeActionsContext.Provider value={false}>
      <div
        className="flex h-full min-w-0 flex-col"
        data-runtime="cloud"
        data-environment-id={runtime.binding.environmentId}
        data-remote-project-id={runtime.binding.remoteProjectId}
      >
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground"
          role="status"
        >
          <span className="min-w-0 break-words">
            {runtime.binding.environmentName} · {runtime.binding.remoteProjectName}
          </span>
          {runtime.status === "connecting" && <Loader2 size={12} className="animate-spin" />}
          {runtime.status === "project-stopped" ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void runtime.start()}>
              {zh ? "启动云端环境" : "Start cloud environment"}
            </Button>
          ) : unavailable && runtime.status !== "connecting" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void runtime.reconnect()}
            >
              {zh ? "重新连接" : "Reconnect"}
            </Button>
          ) : null}
          {runtime.status === "auth-required" && (
            <span>
              {zh ? "请从运行位置菜单重新登录云端。" : "Sign in again from the Work in menu."}
            </span>
          )}
          {runtime.uncertain && (
            <span>
              {zh
                ? "正在确认远程发送状态，请重新连接后恢复。"
                : "Delivery is uncertain. Reconnect to recover the remote status."}
            </span>
          )}
          {runtime.status === "connected" && (runtime.historyFailed || runtime.uncertain) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void runtime.refresh()}
            >
              {zh ? "重新加载云端对话" : "Reload cloud conversation"}
            </Button>
          )}
          {runtime.uploading && <span>{zh ? "正在上传到云端…" : "Uploading to cloud…"}</span>}
        </div>
        {runtime.error && (
          <div
            role="alert"
            className="shrink-0 break-words border-b px-4 py-2 text-sm text-status-err"
          >
            {runtime.error}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ChatView
            {...projects}
            localRuntime={false}
            runLocationControl={runLocationControl}
            composerDisabled={
              unavailable ||
              runtime.loading ||
              runtime.uploading ||
              runtime.uncertain ||
              runtime.historyFailed
            }
            messages={runtime.state.messages}
            awaitingHydration={runtime.loading}
            engineSessionId={runtime.remoteSessionId}
            busy={runtime.busy}
            liveTurnActive={runtime.busy}
            onSend={(text) => {
              void runtime.send(text);
            }}
            onStop={() => {
              void runtime.stop();
            }}
            draft={runtime.draft}
            onDraftChange={runtime.setDraft}
            attachments={[]}
            onAttachmentsChange={() => undefined}
            remoteFiles={runtime.uploads}
            onSelectRemoteFiles={runtime.addFiles}
            onRemoveRemoteFile={runtime.removeUpload}
            permissionMode={null}
            onPermissionChange={() => undefined}
            goalEnabled={false}
            onGoalToggle={() => undefined}
            modelOptions={models}
            activeModelKey={runtime.model}
            onModelChange={(model) => runtime.setModel(model.key)}
            contextTokens={0}
            configurationTarget={{ projectId: runtime.binding.localProjectId }}
            configurationAvailable={false}
            conversationRoot={null}
            conversationRootId={null}
            pendingApproval={runtime.pendingApproval}
            approvalEpoch={runtime.approvalVersion}
            onApprovalDecide={(decision, reason) => {
              if (runtime.pendingApproval)
                void runtime
                  .approve(
                    runtime.pendingApproval.requestId,
                    decision === "approve",
                    undefined,
                    reason,
                  )
                  .catch(() => undefined);
            }}
            onAskUserAnswer={(id, answer) => runtime.approve(id, true, answer)}
          />
        </div>
      </div>
    </LocalRuntimeActionsContext.Provider>
  );
}
