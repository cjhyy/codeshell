import React, { useLayoutEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { ChatView } from "../ChatView";
import { CloudProjectSignIn } from "../projects/CloudProjectSignIn";
import type { TrackedProject } from "../projects";
import { useT } from "../i18n/I18nProvider";
import { Button } from "../components/ui/button";
import { LocalRuntimeActionsContext } from "./RuntimeCapabilities";
import type { CloudProjectRuntimeView } from "./useCloudProjectRuntime";

export interface CloudProjectWorkspaceProps {
  runtime: CloudProjectRuntimeView;
  projects: TrackedProject[];
  activeProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onAddProject: () => void;
}

/** Native desktop conversation surface backed exclusively by the captured cloud connection. */
export function CloudProjectWorkspace({ runtime, ...projects }: CloudProjectWorkspaceProps) {
  const { lang } = useT();
  const zh = lang === "zh";
  const unavailable = runtime.status !== "connected";
  const metadataRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const region = metadataRef.current;
    if (!region) return;
    const ensureFocusedVisible = () => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !region.contains(focused)) return;
      const bounds = region.getBoundingClientRect();
      const target = focused.getBoundingClientRect();
      if (bounds.height <= 0) return;
      if (target.top < bounds.top) region.scrollTop += target.top - bounds.top;
      else if (target.bottom > bounds.bottom) region.scrollTop += target.bottom - bounds.bottom;
    };
    ensureFocusedVisible();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(ensureFocusedVisible);
    observer?.observe(region);
    region.addEventListener("focusin", ensureFocusedVisible);
    return () => {
      observer?.disconnect();
      region.removeEventListener("focusin", ensureFocusedVisible);
    };
  }, [
    runtime.binding.environmentName,
    runtime.binding.remoteProjectName,
    runtime.status,
    runtime.error,
    runtime.uncertain,
    runtime.historyFailed,
    runtime.uploading,
  ]);
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
        className="flex h-full min-h-0 min-w-0 flex-col"
        data-runtime="cloud"
        data-environment-id={runtime.binding.environmentId}
        data-remote-project-id={runtime.binding.remoteProjectId}
      >
        <div
          ref={metadataRef}
          role="region"
          aria-label={zh ? "云端项目状态" : "Cloud project status"}
          tabIndex={0}
          className="max-h-[40%] min-h-0 shrink-0 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground"
            role="status"
          >
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {runtime.binding.environmentName} · {runtime.binding.remoteProjectName}
            </span>
            {runtime.status === "connecting" && <Loader2 size={12} className="animate-spin" />}
            {runtime.status === "project-stopped" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runtime.start()}
              >
                {zh ? "启动云端环境" : "Start cloud environment"}
              </Button>
            ) : unavailable &&
              runtime.status !== "connecting" &&
              runtime.status !== "auth-required" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runtime.reconnect()}
              >
                {zh ? "重新连接" : "Reconnect"}
              </Button>
            ) : null}
            <CloudProjectSignIn
              key={runtime.binding.id}
              binding={runtime.binding}
              required={runtime.status === "auth-required"}
              reconnect={runtime.reconnect}
            />
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
              className="shrink-0 break-words border-b px-4 py-2 text-sm text-status-err [overflow-wrap:anywhere]"
            >
              {runtime.error}
            </div>
          )}
          {runtime.failedSubmissions?.map((submission) => (
            <div
              key={submission.clientMessageId}
              className="border-b px-4 py-2 text-sm"
              role="status"
            >
              <p>{zh ? "未发送的消息已保留。" : "Your unsent message has been preserved."}</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-sans">
                {submission.text}
              </pre>
              {submission.uploads.length > 0 && (
                <p className="break-words">
                  {submission.uploads.map((upload) => upload.name).join(", ")}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={runtime.busy || runtime.uploading}
                onClick={() => runtime.restoreFailedSubmission(submission.clientMessageId)}
              >
                {zh ? "添加到输入框" : "Add to composer"}
              </Button>
            </div>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          <ChatView
            {...projects}
            localRuntime={false}
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
