import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendUserMessage,
  initialChatState,
  reduceStream,
  type ChatState,
} from "@cjhyy/code-shell-web";
import type { MobileImageAttachment } from "@cjhyy/code-shell-core";
import type {
  AccountDeviceConnection,
  AccountDeviceProject,
  AccountExecutionDevice,
} from "../../shared/account-device.js";
import type { CloudAccountStatus } from "../../shared/cloud-account.js";
import type { DesktopRelayStatus } from "../../shared/device-relay.js";

interface Conversation {
  connection?: AccountDeviceConnection;
  status: "idle" | "connecting" | "connected" | "disconnected";
  draft: string;
  attachments: MobileImageAttachment[];
  chat: ChatState;
  error: string;
  uncertain: boolean;
  sending: boolean;
  approvals: Array<{
    id: string;
    workerConnectionId?: string;
    generation?: number;
    title: string;
    body: string;
    answer: string;
    submitted: boolean;
  }>;
}
const fresh = (): Conversation => ({
  status: "idle",
  draft: "",
  attachments: [],
  chat: initialChatState(),
  error: "",
  uncertain: false,
  sending: false,
  approvals: [],
});
const message = (error: unknown) => (error instanceof Error ? error.message : "电脑操作失败。");
const keyFor = (hostId: string, projectId: string) => JSON.stringify([hostId, projectId]);

/** Each Host/project owns its own socket, session, output, approvals and composer. */
export function AccountDeviceWorkspace({ open, onClose }: { open: boolean; onClose(): void }) {
  const [devices, setDevices] = useState<AccountExecutionDevice[]>([]);
  const [projects, setProjects] = useState<AccountDeviceProject[]>([]);
  const [hostId, setHostId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [account, setAccount] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [local, setLocal] = useState<DesktopRelayStatus>();
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const conversationsRef = useRef(conversations);
  const identity = useRef("");
  const revision = useRef(0);
  const targetRevision = useRef(0);
  const refreshRevision = useRef(0);
  const pendingSends = useRef(new Set<string>());
  const key = keyFor(hostId, projectId);
  const current = conversations[key] ?? fresh();
  const selectedDevice = devices.find((device) => device.hostId === hostId);
  const update = useCallback((target: string, patch: (previous: Conversation) => Conversation) => {
    setConversations((previous) => {
      const next = { ...previous, [target]: patch(previous[target] ?? fresh()) };
      conversationsRef.current = next;
      return next;
    });
  }, []);
  const refresh = useCallback(async () => {
    const epoch = revision.current;
    const request = ++refreshRevision.current;
    try {
      const listed = await window.codeshell.accountDevices.list();
      if (epoch === revision.current && request === refreshRevision.current) {
        setDevices(listed);
        setError("");
      }
    } catch (failure) {
      if (epoch === revision.current && request === refreshRevision.current) {
        setDevices([]);
        setError(message(failure));
      }
    }
  }, []);
  useEffect(() => {
    const apply = (next: CloudAccountStatus) => {
      const id = next.state === "signed-in" ? JSON.stringify([next.origin, next.account?.id]) : "";
      if (id !== identity.current) {
        revision.current++;
        targetRevision.current++;
        refreshRevision.current++;
        pendingSends.current.clear();
        identity.current = id;
        conversationsRef.current = {};
        setConversations({});
        setDevices([]);
        setProjects([]);
        setHostId("");
        setProjectId("");
        setLoading(false);
        setResuming(false);
        setError("");
      }
      setAccount(next);
    };
    let changed = false;
    const unsubscribe = window.codeshell.cloudAccount.onStatus((next) => {
      changed = true;
      apply(next);
    });
    void window.codeshell.cloudAccount
      .status()
      .then((next) => {
        if (!changed) apply(next);
      })
      .catch(() => {});
    const relay = window.codeshell.mobileRemote?.relay;
    const unsubscribeRelay = relay?.onStatus(setLocal);
    void relay
      ?.status()
      .then(setLocal)
      .catch(() => {});
    const unsubscribeEvents = window.codeshell.accountDevices.onEvent((envelope) => {
      const target = keyFor(envelope.hostId, envelope.projectId);
      update(target, (previous) => {
        if (
          previous.connection?.id !== envelope.connectionId ||
          previous.connection.sessionId !== envelope.sessionId ||
          previous.connection.environmentId !== envelope.environmentId
        )
          return previous;
        if (envelope.type === "disconnected")
          return {
            ...previous,
            status: "disconnected",
            error: "执行电脑已断线或授权已结束。请核对原电脑任务状态；不会自动重发。",
            uncertain: previous.chat.run === "running" || previous.uncertain,
          };
        const wire = envelope.event!;
        const event = wire.type === "session.stream" ? wire.event : wire;
        if (event?.method === "agent/approvalRequest") {
          const params = event.params;
          if (
            previous.approvals.some(
              (approval) =>
                approval.id === params.requestId &&
                approval.workerConnectionId === params.connectionId &&
                approval.generation === params.generation,
            )
          )
            return previous;
          return {
            ...previous,
            approvals: [
              ...previous.approvals.filter((approval) => approval.id !== params.requestId),
              {
                id: params.requestId,
                workerConnectionId: params.connectionId,
                generation: params.generation,
                title: params.request?.toolName ?? "工具审批",
                body: params.request?.description ?? JSON.stringify(params.request?.args ?? {}),
                answer: "",
                submitted: false,
              },
            ],
          };
        }
        if (wire.type === "approval.resolved" || event?.method === "agent/approvalResolved") {
          const resolved =
            event?.method === "agent/approvalResolved"
              ? event.params
              : { ...wire, requestId: wire.approvalId };
          return {
            ...previous,
            approvals: previous.approvals.filter(
              (approval) =>
                approval.id !== resolved.requestId ||
                approval.workerConnectionId !== resolved.connectionId ||
                approval.generation !== resolved.generation,
            ),
          };
        }
        if (wire.type === "error" || wire.type === "chat.uncertain")
          return {
            ...previous,
            error: wire.message,
            uncertain: wire.type === "chat.uncertain",
            chat: wire.type === "error" ? { ...previous.chat, run: "error" } : previous.chat,
          };
        if (wire.type === "chat.accepted") return { ...previous, uncertain: false };
        return { ...previous, chat: reduceStream(previous.chat, event) };
      });
    });
    return () => {
      unsubscribe();
      unsubscribeRelay?.();
      unsubscribeEvents();
      for (const conversation of Object.values(conversationsRef.current))
        if (conversation.connection)
          void window.codeshell.accountDevices
            .close({ connectionId: conversation.connection.id })
            .catch(() => {});
    };
  }, [update]);
  useEffect(() => {
    if (!open || account.state !== "signed-in") return;
    void refresh();
    const interval = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(interval);
  }, [open, account.state, account.origin, account.account?.id, refresh]);
  const selectHost = async (id: string) => {
    const epoch = ++targetRevision.current;
    setHostId(id);
    setProjectId("");
    setProjects([]);
    setError("");
    setLoading(true);
    try {
      const listed = await window.codeshell.accountDevices.projects({ hostId: id });
      if (epoch === targetRevision.current) setProjects(listed);
    } catch (failure) {
      if (epoch === targetRevision.current) setError(message(failure));
    } finally {
      if (epoch === targetRevision.current) setLoading(false);
    }
  };
  const connect = async (targetHost = hostId, targetProject = projectId) => {
    const target = keyFor(targetHost, targetProject);
    const cached = conversationsRef.current[target];
    if (cached?.status === "connected" || cached?.status === "connecting") return;
    const epoch = revision.current;
    update(target, (previous) => ({ ...previous, status: "connecting", error: "" }));
    try {
      const connection = cached?.connection
        ? await window.codeshell.accountDevices.resume({ connectionId: cached.connection.id })
        : await window.codeshell.accountDevices.connect({
            hostId: targetHost,
            projectId: targetProject,
          });
      if (epoch !== revision.current) {
        void window.codeshell.accountDevices.close({ connectionId: connection.id });
        return;
      }
      update(target, (previous) => ({
        ...previous,
        connection,
        status: "connected",
        uncertain: cached?.connection ? previous.uncertain : false,
        chat: cached?.connection ? previous.chat : initialChatState(),
        approvals: cached?.connection ? previous.approvals : [],
        error: connection.historyNeedsReview
          ? "已恢复原会话。断线期间的历史需要核对；原任务没有重新发送，可继续接收输出、审批和停止。"
          : "",
      }));
    } catch (failure) {
      if (epoch === revision.current)
        update(target, (previous) => ({
          ...previous,
          status: "disconnected",
          error: message(failure),
        }));
    }
  };
  const send = async () => {
    if (
      !current.connection ||
      !current.draft.trim() ||
      current.status !== "connected" ||
      !selectedDevice?.online ||
      selectedDevice.revoked ||
      current.uncertain ||
      current.chat.run === "running" ||
      pendingSends.current.has(key)
    )
      return;
    const target = key;
    const epoch = revision.current;
    const text = current.draft;
    const attachments = current.attachments;
    const estimatedFrame = JSON.stringify({
      type: "chat.send",
      sessionId: current.connection.sessionId,
      clientMessageId: "00000000-0000-4000-8000-000000000000",
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    if (new TextEncoder().encode(estimatedFrame).byteLength > 1_048_576) {
      update(target, (previous) => ({
        ...previous,
        error: "任务与图片合计超过 1 MiB，请压缩图片后发送；本次任务尚未发送。",
      }));
      return;
    }
    pendingSends.current.add(target);
    // Stream events may arrive before the IPC reply. Add the user turn first,
    // then preserve the authoritative terminal state while awaiting that reply.
    update(target, (previous) => ({
      ...previous,
      uncertain: true,
      sending: true,
      error: "",
      chat: { ...appendUserMessage(previous.chat, text, attachments), run: "running" },
    }));
    try {
      const outcome = await window.codeshell.accountDevices.send({
        connectionId: current.connection.id,
        text,
        attachments,
      });
      if (outcome && !outcome.ok)
        throw Object.assign(new Error(outcome.error), { delivery: outcome.delivery });
      if (epoch !== revision.current) return;
      update(target, (previous) => ({
        ...previous,
        draft: previous.draft === text ? "" : previous.draft,
        attachments: previous.attachments.filter(
          (file) => !attachments.some((sent) => sent.clientId === file.clientId),
        ),
      }));
    } catch (failure) {
      if (epoch !== revision.current) return;
      const notSent =
        failure instanceof Error && "delivery" in failure && failure.delivery === "not-sent";
      update(target, (previous) => ({
        ...previous,
        uncertain: !notSent,
        error: message(failure),
        chat: notSent ? { ...previous.chat, run: "error" } : previous.chat,
      }));
    } finally {
      if (epoch === revision.current) {
        pendingSends.current.delete(target);
        update(target, (previous) => ({ ...previous, sending: false }));
      }
    }
  };
  const action = async (run: () => Promise<void>) => {
    const target = key;
    const epoch = revision.current;
    try {
      await run();
    } catch (failure) {
      if (epoch !== revision.current) return;
      update(target, (previous) => ({ ...previous, error: message(failure) }));
    }
  };
  const addFiles = async (files: File[]) => {
    const target = key;
    const epoch = revision.current;
    try {
      if (files.length + current.attachments.length > 8) throw new Error("最多添加 8 张图片。");
      const attachments = await Promise.all(
        files.map(async (file): Promise<MobileImageAttachment> => {
          if (
            !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) ||
            file.size > 5_000_000
          )
            throw new Error("请选择不超过 5 MB 的图片。");
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          return {
            transport: "inline",
            clientId: crypto.randomUUID(),
            name: file.name,
            mime: file.type as "image/png",
            size: file.size,
            dataUrl,
          };
        }),
      );
      if (epoch !== revision.current) return;
      update(target, (previous) => ({
        ...previous,
        attachments: [...previous.attachments, ...attachments],
      }));
    } catch (failure) {
      if (epoch !== revision.current) return;
      update(target, (previous) => ({ ...previous, error: message(failure) }));
    }
  };
  const connected =
    current.status === "connected" && selectedDevice?.online && !selectedDevice.revoked;
  if (!open) return null;
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="执行电脑 / 设备"
      className="absolute inset-0 z-50 flex min-h-0 flex-col bg-background text-foreground"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">执行电脑 / 设备</h1>
          <p className="text-xs text-muted-foreground">同账号电脑 · 任务在所选电脑的项目中执行</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5"
        >
          返回工作台
        </button>
      </header>
      {account.state !== "signed-in" ? (
        <p role="status" className="p-6">
          请先登录账号，登录后本机将自动加入设备协作。
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <aside className="w-full shrink-0 overflow-auto border-b border-border p-4 sm:w-64 sm:border-r sm:border-b-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">账号电脑</h2>
              <button type="button" onClick={() => void refresh()} className="text-xs underline">
                刷新
              </button>
            </div>
            {local && (
              <p className="mb-3 text-xs text-muted-foreground">
                本机：
                {local.state === "ready"
                  ? "在线"
                  : local.state === "connecting"
                    ? "连接中"
                    : local.state === "unauthorized"
                      ? "未授权"
                      : local.state === "unavailable"
                        ? "服务不可用 / 需升级"
                        : "离线"}
                {local.message ? ` · ${local.message}` : ""}
              </p>
            )}
            {(local?.state === "unavailable" || local?.state === "stopped") &&
              window.codeshell.cloudAccount.resume && (
                <button
                  type="button"
                  disabled={resuming}
                  onClick={() => {
                    const epoch = revision.current;
                    setResuming(true);
                    void window.codeshell.cloudAccount.resume!()
                      .then(() => {
                        if (epoch === revision.current) void refresh();
                      })
                      .catch((failure) => {
                        if (epoch === revision.current) setError(message(failure));
                      })
                      .finally(() => setResuming(false));
                  }}
                  className="mb-3 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {resuming ? "正在恢复…" : "恢复设备协作"}
                </button>
              )}
            {devices.map((device) => (
              <button
                type="button"
                key={device.hostId}
                disabled={!device.online || device.revoked}
                aria-pressed={device.hostId === hostId}
                onClick={() => void selectHost(device.hostId)}
                className={`mb-2 block w-full rounded-lg border p-3 text-left disabled:opacity-50 ${device.hostId === hostId ? "border-primary bg-primary/5" : "border-border"}`}
              >
                <span className="block truncate font-medium">
                  {device.name}
                  {device.hostId === local?.hostId ? "（本机）" : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  {device.revoked ? "未授权" : device.online ? "在线" : "离线"}
                </span>
              </button>
            ))}
            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border p-4">
              <label className="text-sm">
                项目{" "}
                <select
                  aria-label="执行项目"
                  disabled={!hostId || loading}
                  value={projectId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setProjectId(id);
                    if (id) void connect(hostId, id);
                  }}
                  className="ml-2 max-w-full rounded-md border border-border bg-background p-2"
                >
                  <option value="">{loading ? "正在读取电脑项目…" : "选择这台电脑的项目"}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name} · {project.path}
                    </option>
                  ))}
                </select>
              </label>
              {projectId && current.status === "connecting" && (
                <p role="status" className="text-xs text-muted-foreground">
                  正在连接执行项目…
                </p>
              )}
              {projectId && current.status === "disconnected" && (
                <button
                  type="button"
                  onClick={() => void connect()}
                  className="rounded-md border border-border px-3 py-2"
                >
                  {current.connection ? "恢复原会话" : "重新连接项目"}
                </button>
              )}
              {current.connection && (
                <p className="break-all text-xs text-muted-foreground">
                  {!selectedDevice?.online
                    ? "设备离线"
                    : current.status === "connected"
                      ? "已连接"
                      : "已断线"}{" "}
                  · {selectedDevice?.name} · 会话 {current.connection.sessionId}
                </p>
              )}
            </div>
            <div
              role="log"
              aria-label="所选电脑任务输出"
              className="min-h-0 flex-1 space-y-3 overflow-auto p-5"
            >
              {!projectId && (
                <p className="text-sm text-muted-foreground">
                  选择在线电脑和项目后即可派发任务。切换电脑会保留各自的草稿、附件与任务输出。
                </p>
              )}
              {current.chat.items.map((item) => (
                <article key={item.id} className="rounded-lg border border-border p-3">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {item.kind === "user"
                      ? "你"
                      : item.kind === "tool"
                        ? item.name
                        : item.kind === "assistant"
                          ? "电脑助手"
                          : "状态"}
                  </p>
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                    {"text" in item
                      ? item.text
                      : item.kind === "tool"
                        ? (item.result ?? item.summary ?? JSON.stringify(item.args))
                        : item.kind === "subagent"
                          ? item.label
                          : ""}
                  </pre>
                </article>
              ))}
            </div>
            {current.error && (
              <p role="alert" className="px-5 py-2 text-sm text-destructive">
                {current.error}
              </p>
            )}
            {current.approvals.map((approval) => (
              <div
                key={approval.id}
                className="mx-5 mb-2 rounded-lg border border-amber-500/50 p-3"
              >
                <p className="font-medium">需要审批 · {approval.title}</p>
                <pre className="whitespace-pre-wrap break-words text-sm">{approval.body}</pre>
                <input
                  aria-label="审批回答"
                  value={approval.answer}
                  onChange={(event) =>
                    update(key, (previous) => ({
                      ...previous,
                      approvals: previous.approvals.map((entry) =>
                        entry.id === approval.id ? { ...entry, answer: event.target.value } : entry,
                      ),
                    }))
                  }
                  className="mt-2 w-full rounded-md border border-border bg-background p-2"
                  placeholder="如需回答问题，在此输入"
                />
                {[true, false].map((approved) => (
                  <button
                    type="button"
                    key={String(approved)}
                    disabled={!connected || approval.submitted}
                    className="mr-2 mt-2 rounded-md border border-border px-3 py-1.5"
                    onClick={() =>
                      void action(async () => {
                        update(key, (previous) => ({
                          ...previous,
                          approvals: previous.approvals.map((entry) =>
                            entry === approval ? { ...entry, submitted: true } : entry,
                          ),
                        }));
                        await window.codeshell.accountDevices.approve({
                          connectionId: current.connection!.id,
                          approvalId: approval.id,
                          ...(approval.workerConnectionId === undefined
                            ? {}
                            : { workerConnectionId: approval.workerConnectionId }),
                          ...(approval.generation === undefined
                            ? {}
                            : { generation: approval.generation }),
                          approved,
                          answer: approval.answer || undefined,
                        });
                      })
                    }
                  >
                    {approved ? "允许这一次" : "拒绝"}
                  </button>
                ))}
              </div>
            ))}
            <div className="shrink-0 space-y-2 border-t border-border p-4">
              <textarea
                aria-label="电脑任务"
                disabled={!projectId}
                value={current.draft}
                onChange={(event) =>
                  update(key, (previous) => ({ ...previous, draft: event.target.value }))
                }
                placeholder="给所选电脑的任务…"
                className="min-h-24 w-full resize-y rounded-lg border border-border bg-background p-3"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm">
                    添加图片
                    <input
                      aria-label="添加图片"
                      className="sr-only"
                      type="file"
                      multiple
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      disabled={!projectId}
                      onChange={(event) => {
                        void addFiles(Array.from(event.target.files ?? []));
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {current.attachments.map((file) => (
                    <button
                      type="button"
                      key={file.clientId}
                      className="text-xs underline"
                      onClick={() =>
                        update(key, (previous) => ({
                          ...previous,
                          attachments: previous.attachments.filter(
                            (item) => item.clientId !== file.clientId,
                          ),
                        }))
                      }
                    >
                      {file.name} ×
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={!connected}
                    onClick={() =>
                      void action(() =>
                        window.codeshell.accountDevices.stop({
                          connectionId: current.connection!.id,
                        }),
                      )
                    }
                    className="rounded-md border border-border px-3 py-1.5"
                  >
                    停止此电脑任务
                  </button>
                  <button
                    type="button"
                    disabled={
                      !connected ||
                      !current.draft.trim() ||
                      current.uncertain ||
                      current.sending ||
                      current.chat.run === "running"
                    }
                    onClick={() => void send()}
                    className="rounded-md bg-primary px-4 py-1.5 text-primary-foreground disabled:opacity-40"
                  >
                    发送到此电脑
                  </button>
                </div>
              </div>
            </div>
          </main>
        </div>
      )}
    </section>
  );
}
