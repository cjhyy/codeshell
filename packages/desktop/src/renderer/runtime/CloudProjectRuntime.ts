import type { CloudProjectBinding } from "../../shared/project-runtime";
import type {
  CloudConfiguration,
  CloudConnection,
  CloudEnvironmentApi,
  CloudEnvironmentEvent,
} from "../../shared/cloud-environment";
import type { ApprovalRequestEnvelope, RendererStreamEvent } from "../../preload/types";
import type { SessionSummary } from "../../shared/session-catalog";
import { compareOutputCursors } from "@cjhyy/code-shell-web";
import { applyTranscriptStreamEvent } from "../transcripts";
import {
  appendAskUserMessage,
  appendUserMessage,
  INITIAL_STATE,
  markAskUserAnswered,
  type MessagesReducerState,
  type AskUserOption,
} from "../types";
import {
  hydrateCloudHistory,
  newerCloudEvent,
  type CloudSessionDetail,
  type CloudStreamCursor,
  type CloudStreamPayload,
  type CloudCoverage,
} from "./cloudHistory";
import type { OutputJournalPage } from "@cjhyy/code-shell-core/internal";

export interface CloudUpload {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}
export type CloudRuntimeStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "auth-required"
  | "project-stopped"
  | "error";
export interface CloudRuntimeSnapshot {
  binding: CloudProjectBinding;
  status: CloudRuntimeStatus;
  connectionId: string | null;
  configuration: CloudConfiguration | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  remoteSessionId: string | null;
  state: MessagesReducerState;
  busy: boolean;
  loading: boolean;
  error: string;
  draft: string;
  uploads: CloudUpload[];
  uploading: boolean;
  pendingApproval: ApprovalRequestEnvelope | null;
  approvalVersion: number;
  uncertain: boolean;
  historyFailed: boolean;
  model: string | null;
}
interface Submission {
  text: string;
  uploads: CloudUpload[];
  clientMessageId: string;
  accepted: boolean;
  uncertain?: boolean;
}
interface PendingApproval extends ApprovalRequestEnvelope {
  sessionId: string;
}
interface SessionMemory {
  draft: string;
  uploads: CloudUpload[];
}

export function cloudSessionUiId(bindingId: string, remoteSessionId: string): string {
  return `cloud:${encodeURIComponent(bindingId)}:${encodeURIComponent(remoteSessionId)}`;
}
function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
function queryData(value: unknown): any {
  const result = record(value);
  return "data" in result ? result.data : value;
}
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One bound environment/project owns its state; no local worker API is reachable here. */
export class CloudProjectRuntime {
  private value: CloudRuntimeSnapshot;
  private listeners = new Set<() => void>();
  private connection: CloudConnection | null = null;
  private generation = 0;
  private selectionGeneration = 0;
  private offEvent?: () => void;
  private offStatus?: () => void;
  private earlyEvents: CloudEnvironmentEvent[] = [];
  private earlyBytes = 0;
  private memories = new Map<string, SessionMemory>();
  private submissions = new Map<string, Submission>();
  private approvals = new Map<string, PendingApproval>();
  private running = new Set<string>();
  private loading: {
    id: string;
    events: CloudStreamPayload[];
    bytes: number;
    overflow: boolean;
    running?: boolean;
  } | null = null;
  private streamCursor?: CloudStreamCursor;
  private blockedHistory = false;
  private remoteIds = new Map<string, string>();
  private reconnecting = false;

  constructor(
    readonly binding: CloudProjectBinding,
    private api: CloudEnvironmentApi,
  ) {
    this.value = {
      binding,
      status: "idle",
      connectionId: null,
      configuration: null,
      sessions: [],
      activeSessionId: null,
      remoteSessionId: null,
      state: INITIAL_STATE,
      busy: false,
      loading: false,
      error: "",
      draft: "",
      uploads: [],
      uploading: false,
      pendingApproval: null,
      approvalVersion: 0,
      uncertain: false,
      historyFailed: false,
      model: null,
    };
  }
  getSnapshot = (): CloudRuntimeSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<CloudRuntimeSnapshot>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  private current(connection: CloudConnection, generation = this.generation): boolean {
    return this.connection === connection && this.generation === generation;
  }
  private selected(connection: CloudConnection, id: string, generation: number): boolean {
    return (
      this.current(connection) &&
      this.value.remoteSessionId === id &&
      this.selectionGeneration === generation
    );
  }
  private updateBusy(): void {
    const id = this.value.remoteSessionId;
    this.publish({
      busy: !!id && (this.running.has(id) || this.submissions.has(id)),
      uncertain:
        !!id &&
        !!this.submissions.get(id) &&
        (this.submissions.get(id)?.uncertain === true || this.value.status !== "connected"),
    });
  }
  private remember(): void {
    this.memories.set(this.value.remoteSessionId ?? "_draft", {
      draft: this.value.draft,
      uploads: this.value.uploads,
    });
  }
  setDraft = (update: string | ((previous: string) => string)): void => {
    this.publish({ draft: typeof update === "function" ? update(this.value.draft) : update });
    this.remember();
  };
  setModel = (model: string): void => {
    this.publish({ model });
  };
  removeUpload = (id: string): void => {
    this.publish({ uploads: this.value.uploads.filter((upload) => upload.id !== id) });
    this.remember();
  };

  connect = async (): Promise<void> => {
    if (this.connection || this.value.status === "connecting") return;
    const generation = ++this.generation;
    this.approvals.clear();
    this.publish({ status: "connecting", loading: !!this.value.remoteSessionId, error: "" });
    this.offEvent = this.api.onEvent((event) => {
      if (
        generation !== this.generation ||
        event.bindingId !== this.binding.id ||
        event.environmentId !== this.binding.environmentId ||
        event.projectId !== this.binding.remoteProjectId
      )
        return;
      if (!this.connection) {
        this.earlyEvents.push(event);
        this.earlyBytes += new TextEncoder().encode(JSON.stringify(event)).length;
        while (this.earlyEvents.length > 2048 || this.earlyBytes > 8 * 1024 * 1024) {
          const removed = this.earlyEvents.shift();
          if (removed) this.earlyBytes -= new TextEncoder().encode(JSON.stringify(removed)).length;
        }
      } else if (event.connectionId === this.connection.connectionId) this.handleEvent(event);
    });
    this.offStatus = this.api.onStatus((status) => {
      if (
        generation !== this.generation ||
        status.bindingId !== this.binding.id ||
        status.connectionId !== this.connection?.connectionId
      )
        return;
      if (status.status === "connected") {
        this.publish({ status: "connected", error: "", loading: !!this.value.remoteSessionId });
        if (!this.reconnecting) {
          this.reconnecting = true;
          void this.refresh().finally(() => {
            this.reconnecting = false;
          });
        }
      } else if (
        status.status === "disconnected" ||
        status.status === "auth-required" ||
        status.status === "closed"
      ) {
        this.selectionGeneration++;
        this.loading = null;
        this.publish({
          status: status.status === "auth-required" ? "auth-required" : "disconnected",
          loading: false,
          pendingApproval: null,
          error: status.error ?? "",
        });
        this.updateBusy();
      }
    });
    try {
      const connection = await this.api.connect({ bindingId: this.binding.id });
      if (generation !== this.generation) {
        await this.api.disconnect({ connectionId: connection.connectionId });
        return;
      }
      if (
        connection.binding.id !== this.binding.id ||
        connection.binding.environmentId !== this.binding.environmentId ||
        connection.binding.remoteProjectId !== this.binding.remoteProjectId
      )
        throw new Error("Cloud connection identity mismatch");
      this.connection = connection;
      this.publish({
        connectionId: connection.connectionId,
        configuration: connection.configuration,
        status: "connected",
        model: this.value.model ?? connection.configuration.defaults.text ?? null,
      });
      this.earlyBytes = 0;
      for (const event of this.earlyEvents.splice(0))
        if (event.connectionId === connection.connectionId) this.handleEvent(event);
      await this.refresh();
    } catch (cause) {
      if (generation !== this.generation) return;
      this.offEvent?.();
      this.offStatus?.();
      this.offEvent = this.offStatus = undefined;
      this.earlyEvents = [];
      this.earlyBytes = 0;
      if (this.connection) {
        void this.api.disconnect({ connectionId: this.connection.connectionId });
        this.connection = null;
      }
      const reason = record(cause).reason;
      this.publish({
        status:
          reason === "project-stopped"
            ? "project-stopped"
            : reason === "auth-required"
              ? "auth-required"
              : "error",
        connectionId: null,
        loading: false,
        error: errorText(cause),
      });
    }
  };
  disconnect = (): void => {
    this.remember();
    this.generation++;
    this.selectionGeneration++;
    const connection = this.connection;
    this.connection = null;
    this.loading = null;
    this.offEvent?.();
    this.offStatus?.();
    this.offEvent = this.offStatus = undefined;
    this.earlyEvents = [];
    this.earlyBytes = 0;
    this.publish({
      status: "idle",
      connectionId: null,
      loading: false,
      uploading: false,
      pendingApproval: null,
    });
    if (connection)
      void this.api.disconnect({ connectionId: connection.connectionId }).catch(() => undefined);
  };
  reconnect = async (): Promise<void> => {
    this.disconnect();
    await this.connect();
  };
  start = async (): Promise<void> => {
    const generation = this.generation;
    this.publish({ status: "connecting", error: "" });
    try {
      await this.api.start({ bindingId: this.binding.id });
      if (generation !== this.generation) return;
      this.publish({ status: "idle" });
      await this.reconnect();
    } catch (cause) {
      if (generation !== this.generation) return;
      this.publish({ status: "project-stopped", error: errorText(cause) });
    }
  };
  private async query(
    connection: CloudConnection,
    type: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    return queryData(
      await this.api.request({
        connectionId: connection.connectionId,
        method: "agent/query",
        params: { type, ...params },
      }),
    );
  }
  refresh = async (): Promise<void> => {
    await this.refreshSessions(true);
  };
  private async refreshSessions(hydrate = false): Promise<void> {
    const connection = this.connection;
    if (!connection || this.value.status !== "connected") return;
    try {
      const result = queryData(
        await this.api.listSessions({ connectionId: connection.connectionId }),
      );
      if (!this.current(connection)) return;
      const rows = Array.isArray(result)
        ? result
        : Array.isArray(result?.sessions)
          ? result.sessions
          : [];
      const sessions: SessionSummary[] = [];
      for (const raw of rows) {
        const row = record(raw);
        if (typeof row.sessionId !== "string") continue;
        const id = cloudSessionUiId(this.binding.id, row.sessionId);
        this.remoteIds.set(id, row.sessionId);
        if (row.running === true) this.running.add(row.sessionId);
        else if (row.running === false) this.running.delete(row.sessionId);
        sessions.push({
          id,
          engineSessionId: row.sessionId,
          title: row.customTitle || row.title || row.preview || row.sessionId.slice(0, 8),
          createdAt: Number(row.startedAt) || 0,
          updatedAt: Number(row.lastActiveAt ?? row.startedAt) || 0,
        });
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      const activeId = this.value.remoteSessionId;
      if (activeId && !sessions.some((session) => session.engineSessionId === activeId)) {
        const previous = this.value.sessions.find(
          (session) => session.engineSessionId === activeId,
        );
        if (
          previous &&
          (this.submissions.has(activeId) || this.value.uploads.length || this.value.draft)
        )
          sessions.unshift(previous);
      }
      this.publish({ sessions });
      this.updateBusy();
      if (hydrate && activeId) await this.loadSession(activeId);
    } catch (cause) {
      if (this.current(connection)) this.publish({ error: errorText(cause), loading: false });
    }
  }
  selectSession = (uiId: string): void => {
    const id = this.remoteIds.get(uiId);
    if (!id || id === this.value.remoteSessionId) return;
    this.remember();
    const memory = this.memories.get(id);
    this.selectionGeneration++;
    this.loading = null;
    this.streamCursor = undefined;
    this.blockedHistory = false;
    this.publish({
      activeSessionId: uiId,
      remoteSessionId: id,
      state: INITIAL_STATE,
      draft: memory?.draft ?? "",
      uploads: memory?.uploads ?? [],
      uploading: false,
      pendingApproval: null,
      error: "",
    });
    this.updateBusy();
    this.projectApprovals();
    void this.loadSession(id);
  };
  newSession = (): void => {
    this.remember();
    this.selectionGeneration++;
    this.loading = null;
    this.streamCursor = undefined;
    this.blockedHistory = false;
    // A deliberate new conversation gets a new draft; old selected drafts remain in memory.
    this.publish({
      activeSessionId: null,
      remoteSessionId: null,
      state: INITIAL_STATE,
      draft: "",
      uploads: [],
      uploading: false,
      busy: false,
      loading: false,
      pendingApproval: null,
      uncertain: false,
      historyFailed: false,
      error: "",
    });
    this.memories.set("_draft", { draft: "", uploads: [] });
  };
  private ensureSession(): string {
    if (this.value.remoteSessionId) return this.value.remoteSessionId;
    const id = crypto.randomUUID();
    const uiId = cloudSessionUiId(this.binding.id, id);
    this.remoteIds.set(uiId, id);
    this.publish({
      remoteSessionId: id,
      activeSessionId: uiId,
      sessions: [
        {
          id: uiId,
          engineSessionId: id,
          title: this.value.draft.trim().split("\n")[0]?.slice(0, 64) || "新对话",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        ...this.value.sessions,
      ],
    });
    this.remember();
    return id;
  }
  private async loadSession(id: string): Promise<void> {
    const connection = this.connection;
    if (!connection || this.value.status !== "connected") return;
    const selection = ++this.selectionGeneration;
    const load = {
      id,
      events: [] as CloudStreamPayload[],
      bytes: 0,
      overflow: false,
      running: undefined as boolean | undefined,
    };
    this.loading = load;
    this.publish({ loading: true, historyFailed: false, error: "" });
    this.blockedHistory = true;
    const canContinue = () => this.selected(connection, id, selection) && this.loading === load;
    try {
      const detail = (await this.query(connection, "session_detail", {
        sessionId: id,
        outputRecovery: true,
      })) as CloudSessionDetail;
      if (!canContinue()) return;
      const restored = await hydrateCloudHistory({
        detail,
        buffered: load.events,
        read: (options) =>
          this.query(connection, "output_journal", {
            sessionId: id,
            ...options,
          }) as Promise<OutputJournalPage>,
        coverage: () =>
          this.query(connection, "output_coverage", { sessionId: id }) as Promise<CloudCoverage>,
        canContinue,
      });
      if (!canContinue()) return;
      if (load.overflow)
        throw new Error("Cloud history changed too quickly; reconnect to recover it");
      this.streamCursor = restored.cursor;
      this.blockedHistory = false;
      if (load.running ?? detail.running) this.running.add(id);
      else this.running.delete(id);
      const submission = this.submissions.get(id);
      const consumed =
        !!submission &&
        restored.state.messages.some(
          (m) => m.kind === "user" && m.clientMessageId === submission.clientMessageId,
        );
      if (submission && (consumed || !this.running.has(id))) {
        this.submissions.delete(id);
        if (!consumed) {
          this.publish({
            draft: this.value.draft || submission.text,
            uploads: this.value.uploads.length ? this.value.uploads : submission.uploads,
          });
          this.remember();
        }
      }
      this.publish({
        state: restored.state,
        loading: false,
        historyFailed: false,
        uncertain: false,
      });
      this.projectApprovals();
      this.updateBusy();
    } catch (cause) {
      if (!canContinue()) return;
      // An upload-only/new draft has no durable session yet; it remains sendable.
      const missing =
        record(cause).code === -32001 && errorText(cause) === `Session not found: ${id}`;
      if (missing) {
        const submission = this.submissions.get(id);
        this.submissions.delete(id);
        this.running.delete(id);
        this.blockedHistory = false;
        this.publish({
          state: INITIAL_STATE,
          loading: false,
          historyFailed: false,
          uncertain: false,
          ...(submission
            ? {
                draft: this.value.draft || submission.text,
                uploads: this.value.uploads.length ? this.value.uploads : submission.uploads,
              }
            : {}),
        });
        this.remember();
        this.updateBusy();
      } else this.publish({ loading: false, historyFailed: true, error: errorText(cause) });
    } finally {
      if (this.loading === load) this.loading = null;
    }
  }
  private handleEvent(payload: CloudEnvironmentEvent): void {
    const params = payload.params as Record<string, any>;
    if (payload.method === "serve/sessionsChanged") {
      void this.refreshSessions();
      return;
    }
    if (payload.method === "serve/configurationChanged") {
      const connection = this.connection!;
      void this.api
        .readConfiguration({ connectionId: connection.connectionId })
        .then((configuration) => {
          if (this.current(connection)) this.publish({ configuration });
        })
        .catch((cause) => {
          if (this.current(connection)) this.publish({ error: errorText(cause) });
        });
      return;
    }
    if (payload.method === "agent/runAccepted" && typeof params.sessionId === "string") {
      const submission = this.submissions.get(params.sessionId);
      if (submission) {
        submission.accepted = true;
        submission.uncertain = false;
      }
      this.running.add(params.sessionId);
      this.updateBusy();
      return;
    }
    if (
      payload.method === "serve/sessionStatus" &&
      typeof params.sessionId === "string" &&
      typeof params.running === "boolean"
    ) {
      if (params.running) this.running.add(params.sessionId);
      else this.running.delete(params.sessionId);
      if (this.loading?.id === params.sessionId) this.loading.running = params.running;
      if (
        !params.running &&
        this.submissions.has(params.sessionId) &&
        params.sessionId === this.value.remoteSessionId
      )
        void this.loadSession(params.sessionId);
      this.updateBusy();
      return;
    }
    if (payload.method === "serve/approvalSnapshot") {
      this.approvals.clear();
      for (const value of Array.isArray(params.approvals) ? params.approvals : [])
        this.addApproval(record(value));
      this.projectApprovals();
      return;
    }
    if (payload.method === "agent/approvalRequest") {
      this.addApproval(params);
      this.projectApprovals();
      return;
    }
    if (payload.method === "agent/approvalResolved" && typeof params.requestId === "string") {
      const previous = this.approvals.get(params.requestId);
      this.approvals.delete(params.requestId);
      if (previous?.sessionId === this.value.remoteSessionId)
        this.publish({ state: markAskUserAnswered(this.value.state, params.requestId, "—") });
      this.projectApprovals();
      return;
    }
    if (
      payload.method !== "agent/streamEvent" ||
      typeof params.sessionId !== "string" ||
      !record(params.event).type
    )
      return;
    const stream = params as CloudStreamPayload;
    const submission = this.submissions.get(stream.sessionId);
    if (submission) submission.accepted = true;
    if (stream.sessionId !== this.value.remoteSessionId) return;
    if (this.loading?.id === stream.sessionId) {
      const load = this.loading;
      const bytes = new TextEncoder().encode(JSON.stringify(stream)).length;
      load.events.push(stream);
      load.bytes += bytes;
      while (load.events.length > 2048 || load.bytes > 8 * 1024 * 1024) {
        const removed = load.events.shift();
        if (removed) load.bytes -= new TextEncoder().encode(JSON.stringify(removed)).length;
        load.overflow = true;
      }
      return;
    }
    if (this.blockedHistory) return;
    if (stream.hubEpoch && this.streamCursor && stream.hubEpoch !== this.streamCursor.epoch) {
      void this.loadSession(stream.sessionId);
      return;
    }
    if (!newerCloudEvent(stream, this.streamCursor)) return;
    const cursor = stream.event.outputCursor;
    if (typeof cursor === "string" && this.value.state.outputCursor) {
      const order = compareOutputCursors(cursor, this.value.state.outputCursor);
      if (order === undefined) {
        void this.loadSession(stream.sessionId);
        return;
      }
      if (order <= 0) return;
    }
    if (stream.hubEpoch && stream.hubSequence !== undefined)
      this.streamCursor = { epoch: stream.hubEpoch, sequence: stream.hubSequence };
    this.publish({
      state: applyTranscriptStreamEvent(this.value.state, stream.event as RendererStreamEvent),
    });
    if (stream.event.type === "turn_complete") void this.refreshSessions();
  }
  private addApproval(payload: Record<string, any>): void {
    if (
      typeof payload.requestId !== "string" ||
      typeof payload.sessionId !== "string" ||
      typeof payload.request?.toolName !== "string"
    )
      return;
    this.approvals.set(payload.requestId, {
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      request: payload.request,
    });
  }
  private projectApprovals(): void {
    let state = this.value.state;
    let pendingApproval: PendingApproval | null = null;
    for (const approval of this.approvals.values()) {
      if (approval.sessionId !== this.value.remoteSessionId) continue;
      if (approval.request.toolName !== "__ask_user__") {
        pendingApproval ??= approval;
        continue;
      }
      const args = record(approval.request.args);
      const options: AskUserOption[] = Array.isArray(args.options)
        ? args.options
            .filter((o) => typeof o?.label === "string")
            .map((o) => ({
              label: o.label,
              description: typeof o.description === "string" ? o.description : "",
              ...(o.tone === "ok" || o.tone === "danger" || o.tone === "neutral"
                ? { tone: o.tone }
                : {}),
            }))
        : [];
      state = appendAskUserMessage(state, {
        requestId: approval.requestId,
        engineSessionId: approval.sessionId,
        question:
          typeof args.question === "string" ? args.question : (approval.request.description ?? ""),
        header: typeof args.header === "string" ? args.header : undefined,
        options,
        multiSelect: args.multiSelect === true,
        optionsOnly: args.optionsOnly === true,
        asynchronous: args.asynchronous === true,
      });
    }
    this.publish({ state, pendingApproval });
  }
  send = async (text: string): Promise<void> => {
    const connection = this.connection;
    if (
      !connection ||
      this.value.status !== "connected" ||
      this.value.busy ||
      this.value.loading ||
      this.value.uploading ||
      this.blockedHistory ||
      (!text.trim() && !this.value.uploads.length)
    )
      return;
    const id = this.ensureSession();
    const clientMessageId = crypto.randomUUID();
    const submission: Submission = {
      text,
      uploads: this.value.uploads,
      clientMessageId,
      accepted: false,
    };
    this.submissions.set(id, submission);
    this.running.add(id);
    this.publish({
      state: appendUserMessage(
        this.value.state,
        text,
        Date.now(),
        undefined,
        undefined,
        undefined,
        true,
        clientMessageId,
        submission.uploads.map((upload) => ({
          kind: upload.mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
          path: "",
          absPath: "",
          sessionId: id,
          originalName: upload.name,
          size: upload.size,
          mime: upload.mimeType,
        })),
      ),
      draft: "",
      uploads: [],
      busy: true,
      uncertain: false,
      error: "",
    });
    this.remember();
    const params: Record<string, unknown> = {
      sessionId: id,
      task: text,
      clientMessageId,
      ...(this.value.model ? { model: this.value.model } : {}),
      ...(submission.uploads.length
        ? { uploadIds: submission.uploads.map((upload) => upload.id) }
        : {}),
    };
    try {
      await this.api.request({
        connectionId: connection.connectionId,
        method: "agent/run",
        params,
      });
      if (!this.current(connection) || this.submissions.get(id) !== submission) return;
      this.submissions.delete(id);
      this.running.delete(id);
      this.updateBusy();
      if (this.value.remoteSessionId === id) await this.refresh();
    } catch (cause) {
      if (this.submissions.get(id) !== submission) return;
      const failure = record(cause);
      // A lost acknowledgment can have executed remotely. Reconcile by clientMessageId, never replay.
      const certain =
        !submission.accepted && (failure.kind === "response" || failure.kind === "not-sent");
      submission.uncertain = !certain;
      if (certain) {
        this.submissions.delete(id);
        this.running.delete(id);
      }
      if (!this.current(connection) || this.value.remoteSessionId !== id) return;
      this.publish({ error: errorText(cause), uncertain: !certain });
      if (certain) {
        this.publish({
          state: {
            ...this.value.state,
            messages: this.value.state.messages.filter(
              (message) =>
                !(
                  message.kind === "user" && message.clientMessageId === submission.clientMessageId
                ),
            ),
          },
          draft: this.value.draft || submission.text,
          uploads: this.value.uploads.length ? this.value.uploads : submission.uploads,
        });
        this.remember();
      } else if (this.value.status === "connected") void this.loadSession(id);
      this.updateBusy();
    }
  };
  stop = async (): Promise<void> => {
    const connection = this.connection;
    const id = this.value.remoteSessionId;
    if (!connection || !id || this.value.status !== "connected") return;
    try {
      await this.api.request({
        connectionId: connection.connectionId,
        method: "agent/cancel",
        params: { sessionId: id },
      });
      if (this.current(connection) && this.value.remoteSessionId === id) await this.loadSession(id);
    } catch (cause) {
      if (this.current(connection) && this.value.remoteSessionId === id)
        this.publish({ error: errorText(cause) });
    }
  };
  approve = async (
    requestId: string,
    approved: boolean,
    answer?: string,
    reason?: string,
  ): Promise<void> => {
    const connection = this.connection;
    const approval = this.approvals.get(requestId);
    const selection = this.selectionGeneration;
    if (
      !connection ||
      !approval ||
      approval.sessionId !== this.value.remoteSessionId ||
      this.value.status !== "connected"
    )
      throw new Error("Cloud approval is no longer available on this connection");
    try {
      await this.api.request({
        connectionId: connection.connectionId,
        method: "agent/approve",
        params: {
          sessionId: approval.sessionId,
          requestId,
          decision: {
            approved,
            ...(answer !== undefined ? { answer } : {}),
            ...(reason ? { reason } : {}),
          },
        },
      });
      if (
        !this.current(connection) ||
        selection !== this.selectionGeneration ||
        approval.sessionId !== this.value.remoteSessionId
      )
        return;
      this.approvals.delete(requestId);
      if (answer !== undefined)
        this.publish({ state: markAskUserAnswered(this.value.state, requestId, answer) });
      this.projectApprovals();
    } catch (cause) {
      if (
        !this.current(connection) ||
        selection !== this.selectionGeneration ||
        approval.sessionId !== this.value.remoteSessionId
      )
        return;
      this.publish({ error: errorText(cause), approvalVersion: this.value.approvalVersion + 1 });
      throw cause;
    }
  };
  addFiles = async (files: File[]): Promise<void> => {
    const connection = this.connection;
    if (
      !connection ||
      this.value.status !== "connected" ||
      this.value.busy ||
      this.value.uploading ||
      this.value.loading
    )
      return;
    if (files.length + this.value.uploads.length > 16) {
      this.publish({ error: "A cloud message can contain at most 16 files" });
      return;
    }
    const id = this.ensureSession();
    const selection = this.selectionGeneration;
    this.publish({ uploading: true, error: "" });
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024)
          throw new Error(`${file.name}: maximum upload size is 20 MiB`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!this.selected(connection, id, selection)) return;
        const upload = await this.api.upload({
          connectionId: connection.connectionId,
          sessionId: id,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          bytes,
        });
        if (!this.selected(connection, id, selection)) return;
        this.publish({ uploads: [...this.value.uploads, upload] });
        this.remember();
      }
    } catch (cause) {
      if (this.selected(connection, id, selection)) this.publish({ error: errorText(cause) });
    } finally {
      if (this.selected(connection, id, selection)) this.publish({ uploading: false });
    }
  };
}
