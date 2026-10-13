import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  CloudConfiguration,
  CloudConnection,
  CloudConnectionStatus,
  CloudEnvironmentDiscovery,
  CloudEnvironmentEvent,
  CloudRemoteProject,
  CloudRequestError,
} from "../shared/cloud-environment";
import type { CloudProjectBinding } from "../shared/project-runtime";
import type { ProjectRuntimeStore } from "./project-runtime-store";
import {
  CLOUD_MAX_FRAME_BYTES,
  CLOUD_MAX_REQUEST_BYTES,
  CLOUD_MAX_UPLOAD_BYTES,
  CLOUD_SESSION_ID,
  CLOUD_UUID,
  normalizeCloudNativeOrigin,
  validateCloudRequest,
} from "./cloud-native-policy";

export class CloudEnvironmentError extends Error implements CloudRequestError {
  constructor(
    message: string,
    readonly kind: CloudRequestError["kind"] = "response",
    readonly status?: number,
    readonly code?: number,
    readonly reason?: CloudRequestError["reason"],
  ) {
    super(message);
  }
}

export interface CloudEnvironmentTransport {
  /** Must use a dedicated origin cookie partition and reject redirects. */
  fetch(origin: string, path: string, init: RequestInit): Promise<Response>;
  /** Only the exact-origin Hub session cookie, never any account credential. */
  cookie(origin: string): Promise<string | undefined>;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: CloudEnvironmentError) => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface Connection {
  id: string;
  owner: number;
  binding: CloudProjectBinding;
  generation: number;
  socket?: WebSocket;
  pending: Map<string, Pending>;
  nextRequest: number;
  closed: boolean;
  retryDelay: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}
interface Options {
  store: ProjectRuntimeStore;
  assertLocalProject: (id: string) => Promise<unknown>;
  transport: CloudEnvironmentTransport;
  ownerAlive: (owner: number) => boolean;
  onEvent: (owner: number, event: CloudEnvironmentEvent) => void;
  onStatus: (owner: number, status: CloudConnectionStatus) => void;
  retryDelayMs?: number;
}
const NOTIFICATIONS = new Set([
  "agent/streamEvent",
  "agent/runAccepted",
  "agent/approvalRequest",
  "agent/approvalResolved",
  "serve/hello",
  "serve/approvalSnapshot",
  "serve/approvalLease",
  "serve/sessionStatus",
  "serve/sessionsChanged",
  "serve/configurationChanged",
  "serve/workerExit",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === "string" &&
  value.length <= maximum &&
  (empty || value.length > 0) &&
  !value.includes("\0");

/** Main-owned remote runtime. It never sends a remote path to a local worker or opens a page. */
export class CloudEnvironmentService {
  private readonly connections = new Map<string, Connection>();
  private readonly operations = new Set<AbortController>();
  private closed = false;

  constructor(private readonly options: Options) {}

  async discover(input: { origin: string }): Promise<CloudEnvironmentDiscovery> {
    const origin = normalizeCloudNativeOrigin(input?.origin);
    const auth = await this.http(origin, "/api/v1/auth/status");
    if (
      !object(auth) ||
      typeof auth.initialized !== "boolean" ||
      typeof auth.authenticated !== "boolean"
    )
      throw new CloudEnvironmentError("服务端返回了无效的登录状态。");
    const result: CloudEnvironmentDiscovery = {
      origin,
      initialized: auth.initialized,
      authenticated: auth.authenticated,
    };
    if (!auth.authenticated) return result;
    const descriptor = await this.http(origin, "/api/v1/environment");
    if (
      !object(descriptor) ||
      descriptor.version !== 1 ||
      typeof descriptor.id !== "string" ||
      !CLOUD_UUID.test(descriptor.id) ||
      descriptor.kind !== "project-host" ||
      descriptor.entryPath !== "/" ||
      typeof descriptor.name !== "string" ||
      !descriptor.name.trim() ||
      descriptor.name.length > 128 ||
      /[\x00-\x1f\x7f]/.test(descriptor.name)
    )
      throw new CloudEnvironmentError(
        "该服务不支持已有云端项目。",
        "response",
        409,
        undefined,
        "identity-mismatch",
      );
    const listing = await this.http(origin, "/api/v1/projects");
    if (!object(listing) || !Array.isArray(listing.projects) || listing.projects.length > 4096)
      throw new CloudEnvironmentError("服务端返回了无效的项目列表。");
    const projects = listing.projects.map((project) => this.project(project));
    return {
      ...result,
      environment: {
        version: 1,
        id: descriptor.id,
        name: descriptor.name,
        kind: "project-host",
        entryPath: "/",
      },
      projects,
    };
  }

  async login(input: {
    origin: string;
    username: string;
    password: string;
  }): Promise<CloudEnvironmentDiscovery> {
    const origin = normalizeCloudNativeOrigin(input?.origin);
    if (
      typeof input.username !== "string" ||
      !input.username.trim() ||
      input.username.length > 256 ||
      typeof input.password !== "string" ||
      !input.password ||
      input.password.length > 4096
    )
      throw new CloudEnvironmentError(
        "请输入有效的用户名和密码。",
        "not-sent",
        400,
        undefined,
        "invalid-input",
      );
    // Credentials live only in this request; neither binding storage nor IPC replies contain them.
    await this.http(origin, "/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        deviceName: "CodeShell Desktop",
      }),
    });
    return this.discover({ origin });
  }

  async listBindings(localProjectId: string): Promise<CloudProjectBinding[]> {
    await this.options.assertLocalProject(localProjectId);
    return this.options.store.list(localProjectId);
  }

  async bind(input: {
    localProjectId: string;
    origin: string;
    environmentId: string;
    remoteProjectId: string;
  }): Promise<CloudProjectBinding> {
    await this.options.assertLocalProject(input?.localProjectId);
    const discovery = await this.discover({ origin: input.origin });
    this.authenticated(discovery);
    if (discovery.environment!.id !== input.environmentId)
      throw new CloudEnvironmentError(
        "云端环境身份已变化，请重新选择。",
        "response",
        409,
        undefined,
        "identity-mismatch",
      );
    const project = discovery.projects!.find((entry) => entry.id === input.remoteProjectId);
    if (!project) throw new CloudEnvironmentError("找不到已有云端项目。", "response", 404);
    // Recheck after authentication/discovery, before persisting a new authority mapping.
    await this.options.assertLocalProject(input.localProjectId);
    return this.options.store.upsert({
      localProjectId: input.localProjectId,
      origin: discovery.origin,
      environmentId: discovery.environment!.id,
      environmentName: discovery.environment!.name,
      remoteProjectId: project.id,
      remoteProjectName: project.name,
    });
  }

  async select(input: { localProjectId: string; bindingId: string | null }) {
    await this.options.assertLocalProject(input?.localProjectId);
    return this.options.store.setSelection(input.localProjectId, input.bindingId);
  }

  async getSelection(localProjectId: string) {
    await this.options.assertLocalProject(localProjectId);
    return this.options.store.getSelection(localProjectId);
  }

  async start(input: { bindingId: string }): Promise<CloudRemoteProject> {
    const binding = await this.binding(input?.bindingId);
    await this.verify(binding, false);
    await this.options.assertLocalProject(binding.localProjectId);
    const result = await this.http(
      binding.origin,
      `/api/v1/projects/${binding.remoteProjectId}/start`,
      { method: "POST", body: "{}" },
      120_000,
    );
    return this.project(object(result) ? result.project : undefined);
  }

  async connect(owner: number, input: { bindingId: string }): Promise<CloudConnection> {
    if (this.closed || !this.options.ownerAlive(owner))
      throw new CloudEnvironmentError("窗口已关闭。", "not-sent");
    if (
      this.connections.size >= 64 ||
      [...this.connections.values()].filter((item) => item.owner === owner).length >= 16
    )
      throw new CloudEnvironmentError("云端连接数量已达上限。", "not-sent");
    const binding = await this.binding(input?.bindingId);
    const project = await this.verify(binding, true);
    const configuration = await this.configuration(binding);
    if (this.closed || !this.options.ownerAlive(owner))
      throw new CloudEnvironmentError("窗口已关闭。", "not-sent");
    if (
      this.connections.size >= 64 ||
      [...this.connections.values()].filter((item) => item.owner === owner).length >= 16
    )
      throw new CloudEnvironmentError("云端连接数量已达上限。", "not-sent");
    const connection: Connection = {
      id: randomUUID(),
      owner,
      binding,
      generation: project.generation,
      pending: new Map(),
      nextRequest: 0,
      closed: false,
      retryDelay: this.options.retryDelayMs ?? 800,
    };
    this.connections.set(connection.id, connection);
    try {
      await this.openSocket(connection);
      return {
        connectionId: connection.id,
        binding,
        configuration,
        generation: project.generation,
      };
    } catch (error) {
      this.closeConnection(connection);
      throw error;
    }
  }

  async request(
    owner: number,
    input: { connectionId: string; method: unknown; params: unknown },
  ): Promise<unknown> {
    const connection = this.owned(owner, input?.connectionId);
    let request: ReturnType<typeof validateCloudRequest>;
    try {
      request = validateCloudRequest(input.method, input.params);
    } catch (error) {
      throw new CloudEnvironmentError(
        (error as Error).message,
        "not-sent",
        400,
        undefined,
        "invalid-input",
      );
    }
    await this.options.assertLocalProject(connection.binding.localProjectId);
    const socket = connection.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new CloudEnvironmentError("云端尚未连接，请等待重新连接。", "not-sent");
    if (connection.pending.size >= 64 || socket.bufferedAmount > CLOUD_MAX_REQUEST_BYTES)
      throw new CloudEnvironmentError("云端请求繁忙，请稍后重试。", "not-sent");
    const id = `desktop-${++connection.nextRequest}`;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (request.method !== "agent/run")
        entry.timer = setTimeout(() => {
          connection.pending.delete(id);
          reject(new CloudEnvironmentError("云端请求超时。", "timeout"));
        }, 30_000);
      connection.pending.set(id, entry);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...request }), (error) => {
        if (!error || !connection.pending.delete(id)) return;
        clearTimeout(entry.timer);
        reject(new CloudEnvironmentError("云端发送中断，请检查会话运行状态。", "transport"));
      });
    });
  }

  async listSessions(owner: number, input: { connectionId: string }): Promise<unknown> {
    const connection = this.owned(owner, input?.connectionId);
    await this.options.assertLocalProject(connection.binding.localProjectId);
    return this.http(connection.binding.origin, this.path(connection.binding, "/api/v1/sessions"));
  }

  async readConfiguration(
    owner: number,
    input: { connectionId: string },
  ): Promise<CloudConfiguration> {
    const connection = this.owned(owner, input?.connectionId);
    await this.options.assertLocalProject(connection.binding.localProjectId);
    return this.configuration(connection.binding);
  }

  async upload(
    owner: number,
    input: {
      connectionId: string;
      sessionId: string;
      name: string;
      mimeType: string;
      bytes: Uint8Array;
    },
  ) {
    const connection = this.owned(owner, input?.connectionId);
    await this.options.assertLocalProject(connection.binding.localProjectId);
    if (
      typeof input.sessionId !== "string" ||
      !CLOUD_SESSION_ID.test(input.sessionId) ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 255 ||
      /[\x00-\x1f/\\]/.test(input.name) ||
      typeof input.mimeType !== "string" ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(input.mimeType) ||
      input.mimeType.length > 128 ||
      !(input.bytes instanceof Uint8Array) ||
      !input.bytes.byteLength ||
      input.bytes.byteLength > CLOUD_MAX_UPLOAD_BYTES
    )
      throw new CloudEnvironmentError(
        "附件无效或超过 20 MiB。",
        "not-sent",
        400,
        undefined,
        "invalid-input",
      );
    const id = randomUUID();
    const result = await this.http(
      connection.binding.origin,
      this.path(connection.binding, `/api/v1/uploads/${id}`),
      {
        method: "PUT",
        body: new Uint8Array(input.bytes).buffer,
        headers: {
          "Content-Type": input.mimeType,
          "X-File-Name": encodeURIComponent(input.name),
          "Content-Length": String(input.bytes.byteLength),
        },
      },
    );
    if (!object(result) || result.id !== id || result.size !== input.bytes.byteLength)
      throw new CloudEnvironmentError("云端返回了无效的附件凭据。");
    return { id, name: input.name, mimeType: input.mimeType, size: input.bytes.byteLength };
  }

  disconnect(owner: number, input: { connectionId: string }): void {
    this.closeConnection(this.owned(owner, input?.connectionId));
  }
  releaseOwner(owner: number): void {
    for (const connection of this.connections.values())
      if (connection.owner === owner) this.closeConnection(connection);
  }
  close(): void {
    this.closed = true;
    for (const controller of this.operations) controller.abort();
    for (const connection of this.connections.values()) this.closeConnection(connection);
  }

  private async binding(id: string): Promise<CloudProjectBinding> {
    if (typeof id !== "string" || !CLOUD_UUID.test(id))
      throw new CloudEnvironmentError("云端关联标识无效。", "not-sent");
    const binding = this.options.store.get(id);
    if (!binding) throw new CloudEnvironmentError("找不到项目的云端关联。", "response", 404);
    await this.options.assertLocalProject(binding.localProjectId);
    return binding;
  }
  private authenticated(discovery: CloudEnvironmentDiscovery): void {
    if (!discovery.authenticated)
      throw new CloudEnvironmentError(
        "请登录这个云端服务。",
        "response",
        401,
        undefined,
        "auth-required",
      );
  }
  private async verify(
    binding: CloudProjectBinding,
    requireRunning: boolean,
  ): Promise<CloudRemoteProject> {
    const discovery = await this.discover({ origin: binding.origin });
    this.authenticated(discovery);
    if (discovery.environment!.id !== binding.environmentId)
      throw new CloudEnvironmentError(
        "云端环境身份已变化，请重新关联项目。",
        "response",
        409,
        undefined,
        "identity-mismatch",
      );
    const project = discovery.projects!.find((entry) => entry.id === binding.remoteProjectId);
    if (!project)
      throw new CloudEnvironmentError("云端项目不存在或当前账号无权访问。", "response", 404);
    if (requireRunning && project.status !== "running")
      throw new CloudEnvironmentError(
        "请先启动这个云端项目。",
        "response",
        409,
        undefined,
        "project-stopped",
      );
    return project;
  }
  private project(value: unknown): CloudRemoteProject {
    if (
      !object(value) ||
      typeof value.id !== "string" ||
      !CLOUD_UUID.test(value.id) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 128 ||
      !["stopped", "starting", "running", "stopping", "error"].includes(String(value.status)) ||
      !Number.isSafeInteger(value.generation) ||
      Number(value.generation) < 0 ||
      !Number.isFinite(value.createdAt) ||
      !Number.isFinite(value.updatedAt) ||
      (value.error !== undefined && !boundedText(value.error, 4096, true))
    )
      throw new CloudEnvironmentError("服务端返回了无效的项目信息。");
    return {
      id: value.id,
      name: value.name,
      status: value.status as CloudRemoteProject["status"],
      generation: value.generation as number,
      createdAt: value.createdAt as number,
      updatedAt: value.updatedAt as number,
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
  }
  private path(binding: CloudProjectBinding, suffix: string): string {
    return `/p/${binding.remoteProjectId}${suffix}`;
  }
  private async configuration(binding: CloudProjectBinding): Promise<CloudConfiguration> {
    const value = await this.http(binding.origin, this.path(binding, "/api/v1/configuration"));
    if (
      !object(value) ||
      !object(value.workspace) ||
      !boundedText(value.workspace.path, 32768) ||
      value.workspace.settingsScope !== "local" ||
      !object(value.defaults) ||
      !Array.isArray(value.connections) ||
      !Array.isArray(value.catalog) ||
      !Array.isArray(value.skills) ||
      !Array.isArray(value.mcpServers) ||
      !Array.isArray(value.workspace.skillDirectories) ||
      value.workspace.skillDirectories.some((path) => !boundedText(path, 32768)) ||
      [value.connections, value.catalog, value.skills, value.mcpServers].some(
        (entries) => entries.length > 4096,
      ) ||
      (value.defaults.text !== undefined && !boundedText(value.defaults.text, 256)) ||
      (value.defaults.auxText !== undefined && !boundedText(value.defaults.auxText, 256)) ||
      typeof value.restartRequired !== "boolean"
    )
      throw new CloudEnvironmentError("服务端返回了无效的模型配置。");
    const invalid = () => new CloudEnvironmentError("服务端返回了无效的模型配置。");
    return {
      workspace: {
        path: value.workspace.path,
        settingsScope: "local",
        skillDirectories: [...value.workspace.skillDirectories],
      },
      defaults: {
        ...(typeof value.defaults.text === "string" ? { text: value.defaults.text } : {}),
        ...(typeof value.defaults.auxText === "string" ? { auxText: value.defaults.auxText } : {}),
      },
      connections: value.connections.map((entry) => {
        if (
          !object(entry) ||
          !boundedText(entry.id, 128) ||
          !boundedText(entry.catalogId, 128) ||
          !boundedText(entry.tag, 128) ||
          !boundedText(entry.model, 256) ||
          !boundedText(entry.baseUrl, 4096, true) ||
          typeof entry.hasApiKey !== "boolean" ||
          typeof entry.needsKey !== "boolean"
        )
          throw invalid();
        return {
          id: entry.id,
          catalogId: entry.catalogId,
          tag: entry.tag,
          model: entry.model,
          baseUrl: entry.baseUrl,
          hasApiKey: entry.hasApiKey,
          needsKey: entry.needsKey,
        };
      }),
      catalog: value.catalog.map((entry) => {
        if (
          !object(entry) ||
          !boundedText(entry.id, 128) ||
          !boundedText(entry.displayName, 256) ||
          !boundedText(entry.adapterKind, 128) ||
          !boundedText(entry.defaultBaseUrl, 4096, true) ||
          typeof entry.needsKey !== "boolean"
        )
          throw invalid();
        return {
          id: entry.id,
          displayName: entry.displayName,
          adapterKind: entry.adapterKind,
          defaultBaseUrl: entry.defaultBaseUrl,
          needsKey: entry.needsKey,
        };
      }),
      skills: value.skills.map((entry) => {
        if (
          !object(entry) ||
          !boundedText(entry.name, 1024) ||
          !boundedText(entry.description, 65536, true) ||
          !boundedText(entry.source, 128) ||
          typeof entry.enabled !== "boolean"
        )
          throw invalid();
        return {
          name: entry.name,
          description: entry.description,
          source: entry.source,
          enabled: entry.enabled,
        };
      }),
      mcpServers: value.mcpServers.map((entry) => {
        if (
          !object(entry) ||
          !boundedText(entry.name, 1024) ||
          !boundedText(entry.transport, 128) ||
          typeof entry.enabled !== "boolean"
        )
          throw invalid();
        return { name: entry.name, transport: entry.transport, enabled: entry.enabled };
      }),
      restartRequired: value.restartRequired,
    };
  }
  private owned(owner: number, id: string): Connection {
    const connection = this.connections.get(id);
    if (
      !connection ||
      connection.owner !== owner ||
      connection.closed ||
      !this.options.ownerAlive(owner)
    )
      throw new CloudEnvironmentError("云端连接不存在或不属于当前窗口。", "not-sent", 403);
    return connection;
  }
  private status(
    connection: Connection,
    status: CloudConnectionStatus["status"],
    error?: string,
  ): void {
    if (this.options.ownerAlive(connection.owner))
      this.options.onStatus(connection.owner, {
        connectionId: connection.id,
        bindingId: connection.binding.id,
        status,
        generation: connection.generation,
        ...(error ? { error } : {}),
      });
  }
  private rejectPending(connection: Connection): void {
    for (const entry of connection.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new CloudEnvironmentError("云端连接中断；已提交的任务可能仍在运行。", "transport"),
      );
    }
    connection.pending.clear();
  }
  private closeConnection(connection: Connection, error?: string): void {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.retryTimer);
    this.connections.delete(connection.id);
    this.rejectPending(connection);
    connection.socket?.terminate();
    this.status(connection, "closed", error);
  }
  private async openSocket(connection: Connection): Promise<void> {
    if (connection.closed || !this.options.ownerAlive(connection.owner))
      throw new CloudEnvironmentError("窗口已关闭。", "not-sent");
    this.status(connection, "connecting");
    const cookie = await this.options.transport.cookie(connection.binding.origin);
    if (!cookie || !/^cs_hub_session=[A-Za-z0-9_-]{43}$/.test(cookie))
      throw new CloudEnvironmentError(
        "请登录这个云端服务。",
        "response",
        401,
        undefined,
        "auth-required",
      );
    if (connection.closed) throw new CloudEnvironmentError("连接已关闭。", "not-sent");
    const url = new URL(this.path(connection.binding, "/ws"), connection.binding.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, {
      headers: { Cookie: cookie, Origin: connection.binding.origin },
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: CLOUD_MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    connection.socket = socket;
    let opened = false;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30_000);
    heartbeat.unref?.();
    socket.on("pong", () => {
      alive = true;
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        opened = true;
        connection.retryDelay = this.options.retryDelayMs ?? 800;
        this.status(connection, "connected");
        resolve();
      });
      socket.on("message", (data, binary) => {
        if (binary || connection.closed || connection.socket !== socket) return;
        let message: unknown;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!object(message) || message.jsonrpc !== "2.0") return;
        if (
          (typeof message.id === "string" || typeof message.id === "number") &&
          message.method === undefined
        ) {
          const entry = connection.pending.get(String(message.id));
          if (!entry) return;
          connection.pending.delete(String(message.id));
          clearTimeout(entry.timer);
          if (object(message.error))
            entry.reject(
              new CloudEnvironmentError(
                typeof message.error.message === "string"
                  ? message.error.message
                  : "云端请求失败。",
                "response",
                undefined,
                typeof message.error.code === "number" ? message.error.code : undefined,
              ),
            );
          else entry.resolve(message.result);
        } else if (
          typeof message.method === "string" &&
          NOTIFICATIONS.has(message.method) &&
          object(message.params)
        ) {
          if (this.options.ownerAlive(connection.owner))
            this.options.onEvent(connection.owner, {
              connectionId: connection.id,
              bindingId: connection.binding.id,
              environmentId: connection.binding.environmentId,
              projectId: connection.binding.remoteProjectId,
              method: message.method,
              params: message.params,
            });
        }
      });
      socket.on("error", () => {
        if (!opened) reject(new CloudEnvironmentError("无法连接云端运行环境。", "transport"));
      });
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        socket.terminate();
        reject(
          new CloudEnvironmentError(
            response.statusCode === 401 ? "云端登录已失效，请重新登录。" : "云端拒绝连接。",
            "response",
            response.statusCode,
            undefined,
            response.statusCode === 401 ? "auth-required" : undefined,
          ),
        );
      });
      socket.on("close", (code) => {
        clearInterval(heartbeat);
        if (!opened) reject(new CloudEnvironmentError("云端连接已关闭。", "transport"));
        if (connection.socket !== socket) return;
        connection.socket = undefined;
        this.rejectPending(connection);
        if (connection.closed) return;
        if (code === 4401 || code === 4403) {
          this.status(connection, "auth-required", "云端登录已失效，请重新登录。");
          return;
        }
        this.status(connection, "disconnected");
        if (opened) this.scheduleReconnect(connection);
      });
    });
  }
  private scheduleReconnect(connection: Connection): void {
    if (connection.closed || this.closed) return;
    connection.retryTimer = setTimeout(async () => {
      try {
        await this.options.assertLocalProject(connection.binding.localProjectId);
      } catch (error) {
        this.closeConnection(connection, (error as Error).message);
        return;
      }
      try {
        const project = await this.verify(connection.binding, true);
        connection.generation = project.generation;
        if (connection.closed) return;
        await this.openSocket(connection);
      } catch (error) {
        if (connection.closed) return;
        if (error instanceof CloudEnvironmentError && error.reason === "auth-required") {
          this.status(connection, "auth-required", error.message);
          return;
        }
        if (
          error instanceof CloudEnvironmentError &&
          (error.reason === "identity-mismatch" || error.status === 404)
        ) {
          this.closeConnection(connection, error.message);
          return;
        }
        this.status(connection, "disconnected", (error as Error).message);
        connection.retryDelay = Math.min(connection.retryDelay * 2, 15_000);
        this.scheduleReconnect(connection);
      }
    }, connection.retryDelay);
    connection.retryTimer.unref?.();
  }
  private async http(
    origin: string,
    path: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.closed) throw new CloudEnvironmentError("云端服务已关闭。", "not-sent");
    const controller = new AbortController();
    this.operations.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.options.transport.fetch(origin, path, {
        ...init,
        method: init.method ?? "GET",
        redirect: "error",
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...init.headers, Origin: origin },
      });
      const declared = Number(response.headers.get("content-length"));
      if (declared > 8 * 1024 * 1024) throw new CloudEnvironmentError("云端响应过大。");
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json"))
        throw new CloudEnvironmentError(
          "云端服务没有返回有效的接口响应。",
          "response",
          response.status,
        );
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > 8 * 1024 * 1024) {
              await reader.cancel();
              throw new CloudEnvironmentError("云端响应过大。");
            }
            chunks.push(item.value);
          }
        } finally {
          reader.releaseLock();
        }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new CloudEnvironmentError("云端服务返回了无效的 JSON。", "response", response.status);
      }
      if (!response.ok)
        throw new CloudEnvironmentError(
          object(body) && typeof body.error === "string" ? body.error : "云端请求失败。",
          "response",
          response.status,
          undefined,
          response.status === 401 ? "auth-required" : undefined,
        );
      return body;
    } catch (error) {
      if (error instanceof CloudEnvironmentError) throw error;
      throw new CloudEnvironmentError(
        controller.signal.aborted ? "云端请求超时。" : "无法访问云端服务。",
        controller.signal.aborted ? "timeout" : "transport",
      );
    } finally {
      clearTimeout(timer);
      this.operations.delete(controller);
    }
  }
}
