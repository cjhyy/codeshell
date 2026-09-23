import { panelExecutionGate, PanelExecutionBusyError } from "./execution-gate.js";
import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listInstalledPanelApps,
  inspectProjectPanelApps,
  CredentialStore,
  validateToolArgsStrict,
  type InstalledPanelApp,
} from "@cjhyy/code-shell-core";
import {
  panelRuntimeApiVersion,
  panelProcessMethods,
  panelResourceMethods,
  panelToolJobMethods,
  panelRuntimeCapabilities,
  PanelBridgeError,
  panelBridgeFailure,
} from "./bridge-contract.js";
import { PanelResourceService } from "./resources/service.js";
import { servePanelResource } from "./resources/http.js";
import {
  panelConnections,
  panelConnectionIds,
  materializePanelConnections,
} from "./connections.js";
import { PanelRuntimeServices } from "./runtime-services.js";
import {
  PanelToolJobService,
  toolJobLimits,
  type ToolJob,
  type ToolJobScope,
  type ToolJobRequest,
  type ToolQueueUpdate,
} from "./tool-jobs.js";
import type { SharedPanelToolHost, SharedPanelToolBinding } from "./shared-tool-jobs.js";
import { createPanelToolExecutor } from "./tool-executor.js";
import { PanelTaskCookieHost } from "./task-cookie-host.js";
import {
  taskCookieFromInput,
  taskCookieSelection,
  type TaskCookieSelection,
} from "./task-cookies.js";
import {
  desktopPanelDirectoryBookmarks,
  hubPanelDirectoryBookmarks,
  type PanelDirectoryAuthorizer,
} from "./directory-bookmarks.js";
import { handlePanelProcessDirectory } from "./process-files.js";
import {
  PanelAppProcessService,
  panelExecutableDirectories,
  panelProcessInfo,
} from "./process-service.js";
import { PanelManagementError } from "./management.js";
import type { PanelSnapshot } from "./types.js";
import { panelAutomationMethods, type PanelAutomationHost } from "./automations.js";

const ASSETS = "/api/v1/panel-assets/";
const ROOT = "/api/v1/panels/runtime/";
const MAX_FILE = 16 * 1024 * 1024;
const GRANT_TTL = 30 * 60_000;
const METHODS = [
  "context.get",
  "storage.get",
  "storage.getSnapshot",
  "storage.compareAndSet",
  "storage.set",
  "storage.delete",
  "workspace.info",
  "workspace.list",
  "workspace.readText",
  "workspace.writeText",
  "external.open",
  "agent.submitPrompt",
  "notifications.send",
  ...panelAutomationMethods,
  ...panelProcessMethods,
  ...panelResourceMethods,
  "resources.open",
  ...panelToolJobMethods,
  "credentials.connections.list",
  "credentials.cookies.listForTask",
  "credentials.cookies.authorizeProcess",
  "credentials.connections.authorizeProcess",
  "agent.task.models",
  "agent.task.start",
  "agent.task.list",
  "agent.task.get",
  "agent.task.cancel",
  "tools.register",
  "tools.unregister",
];
const PERMISSIONS = new Set([
  "context.session",
  "context.workspace",
  "storage",
  "workspace.info",
  "workspace.read",
  "workspace.write",
  "external.open",
  "agent.submitPrompt",
  "notifications.send",
  "process",
  "resources",
  "credentials.connections",
  "credentials.cookies",
  "agent.task",
]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
export const panelWebCompatibility = (
  app: Pick<InstalledPanelApp, "permissions">,
  options?: { automations?: boolean },
) => ({
  supported: true,
  reasons: [
    ...app.permissions
      .filter(
        (permission) =>
          !PERMISSIONS.has(permission) &&
          !(permission === "automations.manage" && options?.automations),
      )
      .map((permission) => "网页暂不提供 " + permission + "，对应功能需要桌面客户端。"),
    ...(app.permissions.includes("credentials.cookies")
      ? [
          "网页可选择 Host 已保存的账号用于后台任务和受授权的临时程序；登录采集和浏览器登录恢复仍需桌面端。",
        ]
      : []),
  ],
});

interface Grant {
  sharedTools?: SharedPanelToolBinding;
  unsubscribeTools?: () => void;
  guestId: number;
  id: string;
  asset: string;
  owner: string;
  request: IncomingMessage;
  origin: string;
  app: InstalledPanelApp;
  revision: string;
  root: string;
  rootIdentity: string;
  files: Map<string, string>;
  expiresAt: number;
  calls: number[];
  transfers: number[];
  context: Record<string, unknown>;
  events: Array<{ id: number; event: string; payload: unknown }>;
  eventCounter: number;
  eventBytes: number;
  registeredTools: Set<string>;
  confirmations: Map<string, { finish: (allowed: boolean) => void; result?: boolean }>;
  toolCalls: Map<string, { finish: (value: { result?: unknown; error?: string }) => void }>;
}
export interface PanelTaskScope {
  instanceId: string;
  ownerId: string;
  appId: string;
  appTitle: string;
  projectPath: string;
  cwd: string;
  permissions: readonly string[];
  availableSkills: readonly string[];
  isAuthorized(): Promise<boolean>;
  emit(event: string, payload: unknown): void;
}
export interface PanelTaskHost {
  call(scope: PanelTaskScope, method: string, params?: unknown): Promise<unknown>;
  revokeInstance(instanceId: string): void;
  close(): void | Promise<void>;
  activeTaskCount?(): number;
}
export interface PanelRuntimeOptions {
  cwd: string;
  bindingCwd?: string;
  projectPackages?: boolean;
  dataDir: string;
  host: "hub" | "desktop";
  publicPathPrefix?: string;
  snapshot: () => Promise<PanelSnapshot>;
  ownerId: (request: IncomingMessage) => Promise<string | undefined>;
  isAuthorized: (request: IncomingMessage) => Promise<boolean>;
  /** Host/test seam. HTTP callers never provide install paths or this catalog. */
  listInstalled?: () => Promise<InstalledPanelApp[]>;
  now?: () => number;
  agentTasks?: PanelTaskHost;
  automations?: PanelAutomationHost;
  /** Reuse the Desktop coordinator; this transport never owns its lifetime. */
  sharedToolJobs?: SharedPanelToolHost;
  authorizePanelDirectory?: PanelDirectoryAuthorizer;
  createAgentTasks?: (hooks: {
    onPanelAction(scope: PanelTaskScope, input: Record<string, unknown>): Promise<unknown>;
  }) => PanelTaskHost;
}
function methodPermission(method: string): string {
  if (method.startsWith("resources.")) return "resources";
  if (method.startsWith("credentials.connections.")) return "credentials.connections";
  if (method.startsWith("credentials.cookies.")) return "credentials.cookies";
  if (method.startsWith("storage.")) return "storage";
  if (method.startsWith("process.") || method.startsWith("filesystem.")) return "process";
  if (method.startsWith("agent.task.")) return "agent.task";
  if (method.startsWith("automations.")) return "automations.manage";
  if (method === "workspace.info") return "workspace.info";
  if (method === "workspace.writeText") return "workspace.write";
  return method.startsWith("workspace.") ? "workspace.read" : method;
}
function error(status: number, message: string): never {
  throw new PanelManagementError(status, "panel_runtime", message);
}
function digest(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
function json(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    error(400, "请发送 JSON 请求。");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > 3 * 1024 * 1024) {
      request.resume();
      error(413, "面板请求内容过大。");
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    /* report below */
  }
  return error(400, "面板请求格式无效。");
}
async function readAsset(root: string, path: string): Promise<Buffer> {
  if (
    !path ||
    path.length > 2048 ||
    path
      .split("/")
      .some((part) => !part || part.startsWith(".") || /[\\:\u0000-\u001f\u007f]/.test(part)) ||
    !MIME[extname(path).toLowerCase()]
  )
    error(404, "找不到面板资源。");
  const file = resolve(root, path);
  if (!file.startsWith(root + sep)) error(403, "面板资源路径无效。");
  const held: Array<{ handle: FileHandle; path: string; dev: number; ino: number }> = [];
  try {
    let current = root;
    const parts = path.split("/");
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = join(current, parts[index]!);
      const parent = held.at(-1);
      const location =
        process.platform === "linux" && parent
          ? `/proc/self/fd/${parent.handle.fd}/${parts[index]}`
          : current;
      const directory = index < parts.length - 1;
      const handle = await open(
        location,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0) |
          (directory ? (constants.O_DIRECTORY ?? 0) : 0),
      );
      const info = await handle.stat().catch(async (cause) => {
        await handle.close();
        throw cause;
      });
      held.push({ handle, path: current, dev: info.dev, ino: info.ino });
      if (directory ? !info.isDirectory() : !info.isFile()) error(403, "面板资源必须是普通文件。");
    }
    const handle = held.at(-1)!.handle;
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE) error(413, "面板资源过大。");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE) error(413, "面板资源过大。");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    for (const entry of held) {
      const actual = await lstat(entry.path);
      if (actual.isSymbolicLink() || actual.dev !== entry.dev || actual.ino !== entry.ino)
        error(409, "面板资源路径已经变化，请重新打开。");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await Promise.all(held.map(({ handle }) => handle.close().catch(() => {})));
  }
}
async function snapshotFiles(root: string, directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let total = 0;
  let count = 0;
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 16) error(413, "面板目录过深。");
    const metadata = await lstat(join(root, path));
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      error(403, "面板目录不能是符号链接。");
    const folder = await opendir(join(root, path));
    for await (const entry of folder) {
      if (++count > 2000 || entry.isSymbolicLink() || entry.name.startsWith("."))
        error(403, "面板文件结构不安全。");
      const child = path + "/" + entry.name;
      if (entry.isDirectory()) await walk(child, depth + 1);
      else {
        const bytes = await readAsset(root, child);
        total += bytes.length;
        if (total > 64 * 1024 * 1024) error(413, "面板资源过大。");
        files.set(child, digest(bytes));
      }
    }
  }
  await walk(directory, 0);
  return files;
}

/** Browser compatibility shim. It receives no login cookie, filesystem path or API credential. */
function bridgeScript(id: string, origin: string): string {
  return `(() => {
    "use strict";
    const id = ${JSON.stringify(id)}, origin = ${JSON.stringify(origin)};
    let next = 0;
    const pending = new Map(), listeners = new Map(), tools = new Map();
    const ask = (method, params) => new Promise((resolve, reject) => {
      if (typeof method !== "string" || method.length > 64) {
        reject(new Error("Invalid panel method")); return;
      }
      if (pending.size >= 64) {
        reject(new Error("Too many pending panel calls")); return;
      }
      const requestId = String(++next);
      const timer = setTimeout(() => {
        pending.delete(requestId); reject(new Error("Panel request timed out"));
      }, ["tasks.start", "tasks.retry", "tasks.queue.set"].includes(method) ? 30 * 60 * 1000 : 60000);
      pending.set(requestId, { resolve, reject, timer });
      try {
        parent.postMessage({ type: "codeshell-panel:call", instanceId: id, requestId, method, params }, origin);
      } catch (error) {
        clearTimeout(timer); pending.delete(requestId); reject(error);
      }
    });
    addEventListener("message", event => {
      if (event.source !== parent || event.origin !== origin || event.data?.instanceId !== id) return;
      const data = event.data;
      if (data.type === "codeshell-panel:response") {
        const item = pending.get(data.requestId);
        if (!item) return;
        pending.delete(data.requestId); clearTimeout(item.timer);
        data.error ? item.reject(Object.assign(new Error(String(data.error)), { code: typeof data.code === "string" ? data.code : "OPERATION_FAILED", ...(typeof data.retryAfterMs === "number" ? { retryAfterMs: data.retryAfterMs } : {}) })) : item.resolve(data.result);
      } else if (data.type === "codeshell-panel:event") {
        if (data.event === "tools.invoke") {
          const call = data.payload;
          const handler = tools.get(call?.toolName);
          Promise.resolve().then(() => {
            if (!handler) throw new Error("Panel tool is not registered");
            return handler(call.args);
          }).then(result => parent.postMessage({ type: "codeshell-panel:tool-result", instanceId: id, requestId: call.requestId, result }, origin),
            error => parent.postMessage({ type: "codeshell-panel:tool-result", instanceId: id, requestId: call.requestId, error: String(error?.message || error).slice(0, 1000) }, origin));
          return;
        }
        for (const listener of listeners.get(data.event) || []) {
          try { listener(data.payload); } catch {}
        }
      }
    });
    addEventListener("pagehide", () => {
      for (const item of pending.values()) {
        clearTimeout(item.timer); item.reject(new Error("Panel closed"));
      }
      pending.clear(); listeners.clear(); tools.clear();
    }, { once: true });
    Object.defineProperty(window, "codeshellPanel", {
      value: Object.freeze({
        getContext: () => ask("context.get"),
        call: ask,
        callResult: (method, params) => ask(method, params).then(value => ({ ok: true, value }), error => ({ ok: false, error: { code: error.code || "OPERATION_FAILED", message: error.message, ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}) } })),
        on: (name, listener) => {
          if (!["context.changed", "process.output", "process.exit", "agent.task.changed", "tasks.changed", "media.job.changed"].includes(name) || typeof listener !== "function") {
            throw new Error("Invalid event listener");
          }
          let list = listeners.get(name);
          if (!list) listeners.set(name, list = new Set());
          list.add(listener);
          return () => list.delete(listener);
        },
        registerTool: (name, handler) => {
          if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof handler !== "function") throw new Error("Invalid tool");
          if (tools.has(name)) throw new Error("Tool already registered");
          if (tools.size >= 16) throw new Error("Too many panel tools");
          tools.set(name, handler);
          void ask("tools.register", { name }).catch(() => tools.delete(name));
          return () => { tools.delete(name); void ask("tools.unregister", { name }).catch(() => {}); };
        }
      }),
      writable: false, configurable: false
    });
    parent.postMessage({ type: "codeshell-panel:ready", instanceId: id }, origin);
  })();`;
}

function parentOrigin(request: IncomingMessage): string {
  // The integrating auth facade validates Origin against its bound/public URL.
  // Origin-less native clients use the transport host; asset requests never
  // control the parent origin or the CSP of an already prepared grant.
  const supplied = request.headers.origin;
  const raw =
    supplied ??
    `${"encrypted" in request.socket && request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (supplied !== undefined && supplied !== url.origin)
    )
      error(400, "面板来源无效。");
    return url.origin;
  } catch {
    return error(400, "面板来源无效。");
  }
}

function injectBridge(html: string, source: string): string {
  const script = '<script src="' + source + '_codeshell_bridge.js"></script>';
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  const firstScript = /<script(?:\s|>)/i.exec(html);
  if (head && (!firstScript || head.index < firstScript.index))
    return (
      html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length)
    );
  const element = /<html(?:\s[^>]*)?>/i.exec(html);
  if (element && (!firstScript || element.index < firstScript.index))
    return (
      html.slice(0, element.index + element[0].length) +
      "<head>" +
      script +
      "</head>" +
      html.slice(element.index + element[0].length)
    );
  const doctype = /^(?:\uFEFF)?\s*<!doctype[^>]*>/i.exec(html);
  const offset = doctype?.[0].length ?? 0;
  return html.slice(0, offset) + script + html.slice(offset);
}

/** Owner-bound capability grants serve reviewed static bytes to an opaque-origin iframe. */
export function createPanelRuntime(options: PanelRuntimeOptions) {
  const publicPathPrefix = options.publicPathPrefix ?? "";
  // An admitted task belongs to the project. Login/page grants only control access.
  const projectOwnedTools = options.host === "hub" || !!options.sharedToolJobs;
  if (
    publicPathPrefix &&
    !/^\/p\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(publicPathPrefix)
  )
    throw new Error("Invalid project public path prefix");
  const grants = new Map<string, Grant>();
  const assets = new Map<string, Grant>();
  const now = options.now ?? Date.now;
  const services = new PanelRuntimeServices({ dataDir: options.dataDir });
  const installed =
    options.listInstalled ??
    (options.projectPackages
      ? async () => (await inspectProjectPanelApps(options.bindingCwd ?? options.cwd)).apps
      : listInstalledPanelApps);
  let closed = false;
  let generation = 0;
  let nextGuest = 0;
  let nextToolOwner = -1;
  const byGuest = new Map<number, Grant>();
  const directoryBookmarks =
    options.host === "desktop"
      ? desktopPanelDirectoryBookmarks(options.dataDir)
      : hubPanelDirectoryBookmarks(options.dataDir);
  const panelDataDirectory = (appId: string) =>
    join(
      options.dataDir,
      "panel-data",
      appId,
      digest(Buffer.from(options.bindingCwd ?? options.cwd)).slice(0, 24),
    );
  const toolOwners = new Map<number, ToolJobScope>();
  const jobOwners = new Map<string, { owner: string; scope: ToolJobScope }>();
  let toolJobs: PanelToolJobService | undefined;
  let taskCookies: PanelTaskCookieHost | undefined;
  function getTaskCookies() {
    if (options.host !== "hub" || options.sharedToolJobs)
      throw new PanelBridgeError("NOT_SUPPORTED", "Background Cookie access is unavailable");
    return (taskCookies ??= new PanelTaskCookieHost({
      rootDirectory: join(options.dataDir, "panel-task-cookies"),
      // A cloud project must not inherit credentials from the controller's user account.
      credentials: async (scope) => new CredentialStore(scope.projectPath).list("project"),
      authorize: async (scope) => {
        if (!(await installedToolApp(scope)).permissions.includes("credentials.cookies"))
          throw new PanelBridgeError("PERMISSION_DENIED", "Tool requires Cookie permission");
      },
    }));
  }
  function cookieAccess(grant: Grant) {
    if (
      !grant.app.permissions.includes("process") ||
      !grant.app.permissions.includes("resources") ||
      !grant.app.permissions.includes("credentials.cookies")
    )
      error(403, "后台账号访问缺少面板权限。");
    if (grant.sharedTools) {
      if (!grant.sharedTools.cookies) error(501, "当前 Host 不支持后台账号授权。");
      return grant.sharedTools.cookies;
    }
    if (options.sharedToolJobs) error(410, "共享任务授权已失效。");
    const scope = {
      appId: grant.app.id,
      projectPath: options.bindingCwd ?? options.cwd,
      revision: grant.revision,
    };
    const host = getTaskCookies();
    return {
      list: (url: string) => host.list(scope, url),
      check: (selection: TaskCookieSelection) => host.check(scope, selection),
      materialize: (selection: TaskCookieSelection) => host.materialize(scope, selection),
    };
  }
  async function taskConsentDetail(grant: Grant, input: unknown, entry: string) {
    const selection = taskCookieFromInput(input);
    if (!selection) return entry;
    const account = await cookieAccess(grant).check(selection);
    return `工具：${entry}\n账号：${account.label}\n站点：${new URL(selection.url).hostname}\n所选登录信息仅交付给已审查的后台程序，任务可在关闭页面后继续。`;
  }
  const localToolRoot =
    options.host === "desktop"
      ? join(options.dataDir, "panel-web-tool-jobs", digest(Buffer.from(options.cwd)).slice(0, 24))
      : join(options.dataDir, "panel-tool-jobs");
  let legacyPresent: Promise<boolean> | undefined;
  async function legacyJobs(scope: ToolJobScope) {
    if (!options.sharedToolJobs || options.host !== "desktop") return [];
    const present = await (legacyPresent ??= lstat(localToolRoot)
      .then((info) => {
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Invalid legacy task store");
        return true;
      })
      .catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw cause;
      }));
    // Opening an existing store marks unfinished jobs interrupted; it never replays them.
    return present
      ? (await getToolJobs().list(scope)).map((job) => ({
          ...job,
          readOnly: true as const,
          historySource: "desktop-web-legacy" as const,
        }))
      : [];
  }
  async function installedToolApp(scope: ToolJobScope) {
    if (closed || scope.projectPath !== (options.bindingCwd ?? options.cwd))
      throw new PanelBridgeError("REVOKED", "Tool task workspace is unavailable");
    const panel = (await snapshot()).panels.find((candidate) => candidate.id === scope.appId);
    const app = (await installed()).find((candidate) => candidate.id === scope.appId);
    if (
      !panel?.enabled ||
      panel.revision !== scope.revision ||
      (panel.packageDigest !== undefined && panel.packageDigest !== app?.packageDigest) ||
      !app?.permissions.includes("process") ||
      !app.permissions.includes("resources")
    )
      throw new PanelBridgeError("REVOKED", "Installed tool task is no longer authorized");
    return app;
  }
  const processes = new PanelAppProcessService({
    acquireExecution: (owner) =>
      panelExecutionGate.enter({
        appId: owner.appId,
        projectPath: options.bindingCwd ?? options.cwd,
      }),
    approvalScope: "guest",
    resolvePackageEntry: async (owner, name) => {
      const taskScope = toolOwners.get(owner.guestId);
      if (taskScope) {
        const app = await installedToolApp(taskScope);
        const entry = app.nativeEntries?.[name];
        if (!entry) throw new PanelBridgeError("REVOKED", "Installed tool entry is unavailable");
        return { path: join(app.installPath, entry.entry), sha256: entry.sha256 };
      }
      const grant = byGuest.get(owner.guestId);
      const entry = grant?.app.nativeEntries?.[name];
      if (
        !grant ||
        !entry ||
        !(await authorized(grant)) ||
        entry.sha256 !== grant.files.get(entry.entry)
      )
        throw new PanelBridgeError("REVOKED", "Installed tool entry is unavailable or changed");
      return { path: join(grant.root, entry.entry), sha256: entry.sha256 };
    },
    extraPathDirectories: () =>
      panelExecutableDirectories(join(options.dataDir, "panel-bin"), { home: homedir() }),
    isOwnerAuthorized: async (owner) => {
      const taskScope = toolOwners.get(owner.guestId);
      if (taskScope) return !!(await installedToolApp(taskScope).catch(() => null));
      const grant = byGuest.get(owner.guestId);
      return !!grant && (await authorized(grant));
    },
    confirmExecution: async (input) => {
      if (toolOwners.has(input.guestId)) return true;
      const grant = byGuest.get(input.guestId);
      return (
        !!grant &&
        (await confirm(
          grant,
          `允许 ${input.appTitle} 运行 ${input.executable}？`,
          `程序将在服务端运行，可使用当前运行用户的文件与网络权限。\n程序：${input.executablePath}`,
        ))
      );
    },
  });
  const resources = new PanelResourceService({
    rootDirectory: join(options.dataDir, "panel-app-media"),
    isScopeAuthorized: async (scope) => {
      if (scope.projectPath === (options.bindingCwd ?? options.cwd)) {
        const panel = (await snapshot()).panels.find((candidate) => candidate.id === scope.appId);
        if (panel?.enabled && panel.permissions.includes("resources")) return true;
      }
      for (const grant of grants.values())
        if (
          grant.app.id === scope.appId &&
          scope.projectPath === (options.bindingCwd ?? options.cwd) &&
          grant.app.permissions.includes("resources") &&
          (await authorized(grant))
        )
          return true;
      return false;
    },
  });
  const agentTasks = options.createAgentTasks?.({ onPanelAction }) ?? options.agentTasks;
  const reaper = setInterval(() => {
    for (const grant of grants.values()) void authorized(grant).catch(() => remove(grant));
  }, 60_000);
  reaper.unref();
  const preparing = new Set<{ owner: string; cancelled: boolean }>();
  const preparingTools = new Set<{ owner: string; appId: string; controller: AbortController }>();
  async function dispatchToolJobs(grant: Grant, method: string, params: unknown) {
    if (!grant.app.permissions.includes("process") || !grant.app.permissions.includes("resources"))
      error(403, "原生后台任务需要 process 和 resources 权限。");
    const scope = {
      appId: grant.app.id,
      projectPath: options.bindingCwd ?? options.cwd,
      revision: grant.revision,
    };
    const input = (params ?? {}) as {
      id?: string;
      entry?: string;
      input?: unknown;
      recovery?: "manual" | "retry";
      requestKey?: string;
      offset?: number;
      limit?: number;
    };
    const shared = grant.sharedTools;
    const service = shared ?? {
      start: (request: ToolJobRequest, signal?: AbortSignal) =>
        getToolJobs().start(scope, request, signal),
      list: () => getToolJobs().list(scope),
      get: (id: string) => getToolJobs().get(scope, id),
      cancel: (id: string) => getToolJobs().cancel(scope, id),
      retry: (id: string) => getToolJobs().retry(scope, id),
      find: (requestKey: string) => getToolJobs().find(scope, requestKey),
      getQueue: () => getToolJobs().getQueue(scope),
      setQueue: (update: ToolQueueUpdate) => getToolJobs().setQueue(scope, update),
    };
    if (options.sharedToolJobs && !shared) error(410, "共享任务授权已失效，请重新打开面板。");
    if (method === "tasks.start") {
      const app = await installedToolApp(scope);
      const entry = app.nativeEntries?.[input.entry ?? ""];
      if (!entry) error(501, "安装的原生工具不可用。");
      const detail = await taskConsentDetail(grant, input.input, input.entry!);
      if (!(await confirm(grant, `启动 ${grant.app.title.default} 的后台工具？`, detail)))
        error(403, "你取消了后台工具执行。");
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      if (taskCookieFromInput(input.input))
        await taskConsentDetail(grant, input.input, input.entry!);
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      const preparation = {
        owner: grant.owner,
        appId: scope.appId,
        controller: new AbortController(),
      };
      preparingTools.add(preparation);
      try {
        const job = await service.start(
          {
            entry: { name: input.entry!, sha256: entry.sha256 },
            input: input.input,
            recovery: input.recovery ?? "manual",
            requestKey: input.requestKey,
          },
          preparation.controller.signal,
        );
        if (!projectOwnedTools && !jobOwners.has(job.id))
          jobOwners.set(job.id, { owner: grant.owner, scope });
        if (!(await authorized(grant))) {
          if (!projectOwnedTools && jobOwners.get(job.id)?.owner === grant.owner)
            await service.cancel(job.id);
          error(410, "登录授权已撤销。");
        }
        if (!shared) emitTaskEvent(await service.get(job.id));
        return job;
      } catch (cause) {
        if (preparation.controller.signal.aborted)
          error(
            410,
            projectOwnedTools
              ? "登录授权已撤销。请重新连接后查询任务，已接收的项目任务可能仍在运行。"
              : "登录授权已撤销，输入准备已取消。",
          );
        throw cause;
      } finally {
        preparingTools.delete(preparation);
      }
    }
    if (method === "tasks.find") return service.find(input.requestKey!);
    if (method === "tasks.queue.get") return service.getQueue();
    if (method === "tasks.queue.set") {
      // Resuming may launch previously admitted jobs; use the existing owner consent gate.
      if (
        !(await confirm(
          grant,
          `调整 ${grant.app.title.default} 的后台队列？`,
          "暂停只影响等待任务，正在执行的任务继续运行。",
        ))
      )
        error(403, "你取消了队列调整。");
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      return service.setQueue(params as ToolQueueUpdate);
    }
    if (method === "tasks.list") {
      const offset = input.offset ?? 0,
        limit = input.limit ?? 50;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        throw new PanelBridgeError("INVALID_ARGUMENT", "Invalid task page");
      const jobs = [...(await service.list()), ...(await legacyJobs(scope))].sort(
        (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
      );
      return jobs.slice(offset, offset + limit).map((job) => toolSummary(job));
    }
    if (shared && ["tasks.get", "tasks.cancel", "tasks.retry"].includes(method)) {
      // Explicitly identify legacy IDs. Authorization failures on the shared service
      // must never fall through to a less restrictive coordinator.
      if (!(await shared.has(input.id!))) {
        const legacy = (await legacyJobs(scope)).find((job) => job.id === input.id);
        if (legacy) {
          if (method === "tasks.get") return legacy;
          throw new PanelBridgeError(
            "NOT_SUPPORTED",
            "旧网页任务仅供查看，请从原输入创建新的共享任务。",
          );
        }
      }
    }
    if (method === "tasks.get") return service.get(input.id!);
    if (method === "tasks.cancel") return service.cancel(input.id!);
    if (method === "tasks.retry") {
      const previous = await service.get(input.id!);
      if (previous.readOnly)
        throw new PanelBridgeError("NOT_SUPPORTED", "旧任务仅供查看，请检查输入后创建新任务。");
      const detail = await taskConsentDetail(grant, previous.input, previous.entry.name);
      if (!(await confirm(grant, `重试 ${grant.app.title.default} 的后台工具？`, detail)))
        error(403, "你取消了后台工具重试。");
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      if (taskCookieFromInput(previous.input))
        await taskConsentDetail(grant, previous.input, previous.entry.name);
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      const job = await service.retry(input.id!);
      if (!projectOwnedTools) jobOwners.set(job.id, { owner: grant.owner, scope });
      if (!(await authorized(grant))) {
        if (!projectOwnedTools) await service.cancel(job.id);
        error(410, "登录授权已撤销，请重新连接后查看任务状态。");
      }
      if (!shared) emitTaskEvent(await service.get(job.id));
      return job;
    }
    throw new PanelBridgeError("NOT_SUPPORTED", "Unknown tool task operation");
  }
  function toolSummary(job: ToolJob) {
    const { input: _input, result: _result, ...summary } = job;
    return summary;
  }
  function emitTaskEvent(job: ToolJob) {
    const owner = jobOwners.get(job.id)?.owner;
    if (!projectOwnedTools && !owner) return;
    for (const grant of grants.values())
      if (
        (projectOwnedTools || grant.owner === owner) &&
        job.scope.projectPath === (options.bindingCwd ?? options.cwd) &&
        grant.app.id === job.scope.appId &&
        grant.revision === job.scope.revision &&
        grant.app.permissions.includes("process") &&
        grant.app.permissions.includes("resources")
      )
        emit(grant, "tasks.changed", toolSummary(job));
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status))
      jobOwners.delete(job.id);
  }
  function getToolJobs(): PanelToolJobService {
    if (toolJobs) return toolJobs;
    const executor = createPanelToolExecutor({
      ...(options.host === "hub" && !options.sharedToolJobs ? { cookies: getTaskCookies() } : {}),
      processes,
      resources,
      owner: (job, send) => {
        const guestId = nextToolOwner--;
        toolOwners.set(guestId, job.scope);
        return {
          guestId,
          appId: job.scope.appId,
          appTitle: job.scope.appId,
          revision: job.scope.revision,
          send,
        };
      },
      releaseOwner: (owner) => {
        toolOwners.delete(owner.guestId);
      },
      authorize: async (scope) => {
        await installedToolApp(scope);
      },
      authorizeConnections: async (scope) => {
        const app = await installedToolApp(scope);
        if (!app.permissions.includes("credentials.connections"))
          throw new PanelBridgeError("PERMISSION_DENIED", "Tool requires connection permission");
      },
      resolveDirectoryBookmark: async (scope, bookmark) => {
        await installedToolApp(scope);
        return directoryBookmarks.restore(scope.appId, scope.projectPath, bookmark);
      },
      appDataDirectory: async (scope) => {
        await installedToolApp(scope);
        const path = panelDataDirectory(scope.appId);
        await mkdir(path, { recursive: true, mode: 0o700 });
        return path;
      },
      sealedRoot: join(options.dataDir, "panel-app-sealed"),
    });
    toolJobs = new PanelToolJobService({
      // Separate legacy store when a Desktop coordinator is injected. Existing
      // history stays readable; shared jobs never acquire a second disk lock.
      rootDir: localToolRoot,
      ...executor,
      isAuthorized: async (scope) => !!(await installedToolApp(scope).catch(() => null)),
      describePackage: async (scope) => {
        const app = await installedToolApp(scope);
        if (!app.packageDigest) throw new Error("Project package digest is unavailable");
        return { version: app.version, packageDigest: app.packageDigest };
      },
      onEvent: emitTaskEvent,
    });
    return toolJobs;
  }
  let readingSnapshot: Promise<PanelSnapshot> | undefined;
  function snapshot() {
    // Parallel module requests share current disk work, without a stale TTL
    // that could keep an unbound or updated package authorized.
    const pending = readingSnapshot ?? options.snapshot();
    readingSnapshot = pending;
    void pending
      .finally(() => {
        if (readingSnapshot === pending) readingSnapshot = undefined;
      })
      .catch(() => {});
    return pending;
  }
  function remove(grant: Grant) {
    if (grants.get(grant.id) !== grant) return;
    grant.unsubscribeTools?.();
    grants.delete(grant.id);
    assets.delete(grant.asset);
    byGuest.delete(grant.guestId);
    processes.revokeGuest(grant.guestId);
    agentTasks?.revokeInstance(grant.id);
    for (const item of grant.confirmations.values()) item.finish(false);
    for (const item of grant.toolCalls.values())
      item.finish({ error: "面板已经关闭或授权已撤销。" });
    grant.events.length = 0;
  }
  function emit(grant: Grant, event: string, payload: unknown) {
    if (grants.get(grant.id) !== grant) return;
    const bytes = Buffer.byteLength(JSON.stringify(payload) ?? "null");
    if (
      bytes > 512 * 1024 ||
      grant.events.length >= 1024 ||
      grant.eventBytes + bytes > 5 * 1024 * 1024
    ) {
      remove(grant);
      return;
    }
    grant.eventBytes += bytes;
    grant.events.push({ id: ++grant.eventCounter, event, payload });
  }
  async function confirm(grant: Grant, title: string, message: string): Promise<boolean> {
    if (grant.confirmations.size >= 48) {
      for (const [id, value] of grant.confirmations) {
        if (value.result !== undefined) grant.confirmations.delete(id);
        if (grant.confirmations.size < 32) break;
      }
    }
    if (!(await authorized(grant)) || grant.confirmations.size >= 64) return false;
    const requestId = randomBytes(18).toString("base64url");
    const result = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => finish(false), 50_000);
      timer.unref();
      let settled = false;
      const finish = (allowed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const entry = grant.confirmations.get(requestId);
        if (entry) entry.result = allowed;
        done(allowed);
      };
      grant.confirmations.set(requestId, { finish });
      emit(grant, "host.confirm", {
        requestId,
        title: title.slice(0, 180),
        body: message.slice(0, 8000),
      });
    });
    return result && (await authorized(grant));
  }
  function taskScope(grant: Grant): PanelTaskScope {
    return {
      instanceId: grant.id,
      ownerId: grant.owner,
      appId: grant.app.id,
      appTitle: grant.app.title.default,
      projectPath: options.bindingCwd ?? options.cwd,
      cwd: options.cwd,
      permissions: grant.app.permissions,
      availableSkills: (grant.app.agent?.skills ?? []).flatMap((path) => {
        const match = /^agent\/skills\/([a-z][a-z0-9-]{0,63})\/SKILL\.md$/.exec(path);
        return match ? [`${grant.app.id}:${match[1]}`] : [];
      }),
      isAuthorized: () => authorized(grant),
      emit: (event, payload) => {
        if (event === "agent.task.approvalRequested") {
          const input = payload as Record<string, unknown>;
          void confirm(
            grant,
            String(input.title ?? "允许面板 AI 任务执行此操作？"),
            String(input.body ?? JSON.stringify(input.request ?? input)),
          )
            .then((approved) =>
              agentTasks?.call(taskScope(grant), "agent.task.approvalRespond", {
                taskId: input.taskId,
                requestId: input.requestId,
                approved,
              }),
            )
            .catch(() => {});
        } else emit(grant, event, payload);
      },
    };
  }
  async function onPanelAction(
    scope: PanelTaskScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return panelExecutionGate.run(
      { appId: scope.appId, projectPath: options.bindingCwd ?? options.cwd },
      () => onPanelActionAdmitted(scope, input),
    );
  }
  async function onPanelActionAdmitted(
    scope: PanelTaskScope,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const grant = grants.get(scope.instanceId);
    if (!grant || grant.owner !== scope.ownerId || !(await authorized(grant)))
      return { ok: false, detail: "面板已关闭或授权已撤销。" };
    const panelId = `panel-app:${grant.app.id}`;
    if (input.action === "list")
      return {
        ok: true,
        panels: [{ id: panelId, title: grant.app.title.default, source: "panel-app" }],
      };
    if (input.panelId !== panelId && input.panelId !== grant.app.id)
      return { ok: false, detail: "这个任务只能操作发起它的面板。" };
    if (input.action === "open") return { ok: true, panelId: input.panelId };
    const descriptors = (grant.app.agent?.tools ?? []).filter((tool) =>
      grant.registeredTools.has(tool.name),
    );
    if (input.action === "tools") return { ok: true, tools: descriptors };
    const tool = descriptors.find((entry) => entry.name === input.toolName);
    if (input.action !== "invoke" || !tool) return { ok: false, detail: "这个面板工具尚未注册。" };
    const args = input.arguments ?? {};
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Buffer.byteLength(JSON.stringify(args)) > 128 * 1024
    )
      return { ok: false, detail: "面板工具参数格式无效或过大。" };
    const validation = validateToolArgsStrict(
      tool.name,
      args as Record<string, unknown>,
      tool.inputSchema,
    );
    if (validation) return { ok: false, detail: validation };
    if (
      !tool.readOnly &&
      !(await confirm(
        grant,
        `允许面板工具 ${tool.name} 修改内容？`,
        JSON.stringify(args).slice(0, 8000),
      ))
    )
      return { ok: false, detail: "用户取消了面板工具操作。" };
    if (grant.toolCalls.size >= 16) return { ok: false, detail: "面板工具调用过多。" };
    const releaseExecution = panelExecutionGate.enter({
      appId: grant.app.id,
      projectPath: options.bindingCwd ?? options.cwd,
    });
    const requestId = randomBytes(18).toString("base64url");
    const value = await new Promise<{ result?: unknown; error?: string }>((done) => {
      // Keep the operation occupied after the caller stops waiting. A late reply
      // or revoked guest ends it; a timeout alone is not proof of termination.
      const timer = setTimeout(() => done({ error: "面板工具调用超时。" }), 45_000);
      timer.unref();
      const finish = (result: { result?: unknown; error?: string }) => {
        if (!grant.toolCalls.delete(requestId)) return;
        releaseExecution();
        clearTimeout(timer);
        done(result);
      };
      grant.toolCalls.set(requestId, { finish });
      emit(grant, "tools.invoke", { requestId, toolName: tool.name, args });
    });
    if (!(await authorized(grant))) return { ok: false, detail: "面板授权已撤销。" };
    return {
      ok: !value.error,
      panelId: input.panelId,
      toolName: tool.name,
      ...(value.error ? { detail: value.error } : { result: value.result }),
    };
  }
  function cancelOwner(owner: string) {
    for (const preparation of preparingTools)
      if (preparation.owner === owner) preparation.controller.abort();
    for (const preparation of preparing)
      if (preparation.owner === owner) preparation.cancelled = true;
    for (const grant of grants.values()) if (grant.owner === owner) remove(grant);
    for (const [id, record] of jobOwners)
      if (record.owner === owner) void toolJobs?.cancel(record.scope, id).catch(() => {});
  }
  async function authorized(grant: Grant): Promise<boolean> {
    if (
      closed ||
      grants.get(grant.id) !== grant ||
      grant.expiresAt <= now() ||
      !(await options.isAuthorized(grant.request)) ||
      (await options.ownerId(grant.request)) !== grant.owner
    ) {
      remove(grant);
      return false;
    }
    try {
      const panel = (await snapshot()).panels.find((candidate) => candidate.id === grant.app.id);
      const info = await lstat(grant.root);
      const ownerStillAuthorized = await options.isAuthorized(grant.request);
      const currentOwner = await options.ownerId(grant.request);
      if (grant.app.permissions.includes("process"))
        await options.authorizePanelDirectory?.(
          grant.app,
          options.bindingCwd ?? options.cwd,
          options.cwd,
        );
      const valid =
        !closed &&
        grants.get(grant.id) === grant &&
        grant.expiresAt > now() &&
        ownerStillAuthorized &&
        currentOwner === grant.owner &&
        !!panel?.enabled &&
        panel.revision === grant.revision &&
        !info.isSymbolicLink() &&
        info.isDirectory() &&
        info.dev + ":" + info.ino === grant.rootIdentity;
      if (!valid) remove(grant);
      return valid;
    } catch {
      remove(grant);
      return false;
    }
  }
  async function prepare(request: IncomingMessage, input: Record<string, unknown>) {
    const owner = await options.ownerId(request);
    if (!owner || !(await options.isAuthorized(request))) error(401, "请先登录。");
    if (closed) error(410, "面板服务已关闭，请重新打开工作台。");
    if (preparing.size >= 4 || [...preparing].filter((item) => item.owner === owner).length >= 2)
      error(429, "正在打开的面板过多，请稍后重试。");
    const preparation = { owner, cancelled: false };
    preparing.add(preparation);
    try {
      const startedGeneration = generation;
      const origin = parentOrigin(request);
      if (
        typeof input.appId !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(input.appId) ||
        typeof input.revision !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.revision) ||
        Object.keys(input).some(
          (key) => !["appId", "revision", "sessionId", "theme", "locale"].includes(key),
        )
      )
        error(400, "面板参数无效。");
      const panel = (await snapshot()).panels.find((candidate) => candidate.id === input.appId);
      if (!panel?.enabled || !panel.compatibility.supported)
        error(403, "请先将面板绑定到当前工作区。");
      if (panel.revision !== input.revision) error(409, "面板已经更新，请重新打开。");
      if (
        input.sessionId !== undefined &&
        (typeof input.sessionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.sessionId))
      )
        error(400, "会话标识无效。");
      const app = (await installed()).find((candidate) => candidate.id === input.appId);
      if (!app) error(404, "面板已卸载。");
      if (panel.packageDigest && panel.packageDigest !== app.packageDigest)
        error(409, "项目面板版本已改变，请重新打开。");
      const root = await realpath(app.installPath),
        info = await lstat(app.installPath);
      if (info.isSymbolicLink() || !info.isDirectory()) error(403, "面板安装目录无效。");
      const files = await snapshotFiles(root, dirname(app.entry));
      if (!files.has(app.entry)) error(404, "找不到面板入口。");
      if (closed || generation !== startedGeneration || preparation.cancelled)
        error(410, "面板授权已失效，请重新打开。");
      const sharedTools =
        options.sharedToolJobs &&
        app.permissions.includes("process") &&
        app.permissions.includes("resources")
          ? await options.sharedToolJobs.bind(app, options.bindingCwd ?? options.cwd)
          : undefined;
      if (closed || generation !== startedGeneration || preparation.cancelled)
        error(410, "面板授权已失效，请重新打开。");
      for (const grant of grants.values()) if (grant.expiresAt <= now()) remove(grant);
      if (
        grants.size >= 64 ||
        [...grants.values()].filter((grant) => grant.owner === owner).length >= 16
      )
        error(429, "打开的面板过多，请先关闭一些面板。");
      const id = randomBytes(24).toString("base64url"),
        asset = randomBytes(32).toString("base64url");
      const context: Record<string, unknown> = {
        appId: app.id,
        visible: true,
        theme: input.theme === "dark" ? "dark" : "light",
        locale: typeof input.locale === "string" ? input.locale.slice(0, 32) : "zh-CN",
        apiVersion: panelRuntimeApiVersion,
        capabilities: {
          ...panelRuntimeCapabilities({
            process: app.permissions.includes("process"),
            cookieProcess:
              app.permissions.includes("process") &&
              app.permissions.includes("resources") &&
              app.permissions.includes("credentials.cookies") &&
              (sharedTools
                ? !!sharedTools.cookies?.materialize
                : options.host === "hub" && !options.sharedToolJobs),
            resources: app.permissions.includes("resources") ? resources.capabilities() : undefined,
            tasks:
              app.permissions.includes("process") && app.permissions.includes("resources")
                ? {
                    available: true,
                    directoryBookmarks: true,
                    queueControl: true,
                    cookieCredentials:
                      app.permissions.includes("credentials.cookies") &&
                      (sharedTools
                        ? !!sharedTools.cookies
                        : options.host === "hub" && !options.sharedToolJobs),
                    ...toolJobLimits,
                    ownership: projectOwnedTools ? "project" : "session",
                    executionRevision: sharedTools?.scope.revision ?? panel.revision,
                    sharedAcrossDevices: projectOwnedTools,
                    continuesAfterDisconnect: true,
                    continuesAfterLogout: projectOwnedTools,
                    maxHttpResultBytes: toolJobLimits.maxRecordBytes + 128 * 1024,
                  }
                : undefined,
            limits: {
              maxParamsBytes: 3 * 1024 * 1024,
              maxResultBytes: 3 * 1024 * 1024,
              rateWindowMs: 60000,
              maxCallsPerWindow: 240,
              maxTransferCallsPerWindow: 2048,
              callTimeoutMs: 60000,
              consentTimeoutMs: 50000,
            },
          }),
          ...(app.permissions.includes("process") && app.permissions.includes("resources")
            ? {
                methodLimits: {
                  "tasks.start": {
                    maxParamsBytes: toolJobLimits.maxInputBytes,
                    maxResultBytes: toolJobLimits.maxRecordBytes + 128 * 1024,
                    timeoutMs: 30 * 60 * 1000,
                  },
                  "tasks.find": { maxResultBytes: toolJobLimits.maxRecordBytes + 128 * 1024 },
                  "tasks.get": { maxResultBytes: toolJobLimits.maxRecordBytes + 128 * 1024 },
                  "tasks.retry": {
                    maxResultBytes: toolJobLimits.maxRecordBytes + 128 * 1024,
                    timeoutMs: 30 * 60 * 1000,
                  },
                  "tasks.cancel": { maxResultBytes: toolJobLimits.maxRecordBytes + 128 * 1024 },
                },
              }
            : {}),
        },
        host: options.host,
        availableMethods: METHODS.filter((method) => {
          if (
            method === "credentials.cookies.listForTask" ||
            method === "credentials.cookies.authorizeProcess"
          )
            return (
              app.permissions.includes("credentials.cookies") &&
              app.permissions.includes("process") &&
              app.permissions.includes("resources") &&
              (sharedTools
                ? method === "credentials.cookies.authorizeProcess"
                  ? !!sharedTools.cookies?.materialize
                  : !!sharedTools.cookies
                : options.host === "hub" && !options.sharedToolJobs)
            );
          if (method.startsWith("agent.task.") && !agentTasks) return false;
          if (method.startsWith("automations."))
            return (
              !!options.automations &&
              ["automations.manage", "context.workspace", "context.session"].every((permission) =>
                app.permissions.includes(permission as never),
              ) &&
              !!input.sessionId
            );
          if (method.startsWith("tasks."))
            return app.permissions.includes("process") && app.permissions.includes("resources");
          if (
            [
              "resources.materialize",
              "resources.capture",
              "resources.references.create",
              "resources.references.relink",
              "credentials.connections.authorizeProcess",
            ].includes(method) &&
            !app.permissions.includes("process")
          )
            return false;
          if (method.startsWith("tools.")) return !!app.agent?.tools.length;
          return (
            method === "context.get" || app.permissions.includes(methodPermission(method) as never)
          );
        }),
        limitations: panel.compatibility.reasons,
      };
      if (app.permissions.includes("context.workspace")) {
        context.cwd = options.cwd;
        context.trusted = true;
      }
      if (app.permissions.includes("context.session") && input.sessionId) {
        context.sessionId = input.sessionId;
        context.busy = false;
      }
      const grant: Grant = {
        sharedTools,
        guestId: ++nextGuest,
        id,
        asset,
        owner,
        request,
        origin,
        app,
        revision: panel.revision,
        root,
        rootIdentity: info.dev + ":" + info.ino,
        files,
        context,
        expiresAt: now() + GRANT_TTL,
        calls: [],
        transfers: [],
        events: [],
        eventCounter: 0,
        eventBytes: 0,
        registeredTools: new Set(),
        confirmations: new Map(),
        toolCalls: new Map(),
      };
      grants.set(id, grant);
      byGuest.set(grant.guestId, grant);
      assets.set(asset, grant);
      if (sharedTools) {
        // Keep event order across asynchronous viewer-authorization checks. A slow
        // or revoked viewer cannot stop the owning coordinator or another viewer.
        let events = Promise.resolve();
        let pendingEvents = 0;
        grant.unsubscribeTools = sharedTools.subscribe((job) => {
          if (++pendingEvents > 1024) {
            remove(grant);
            return;
          }
          events = events
            .then(async () => {
              // The native Host may have revoked project trust independently of
              // this Web session. Check both authorities before sending metadata.
              if ((await sharedTools.has(job.id)) && (await authorized(grant)))
                emit(grant, "tasks.changed", job);
              pendingEvents--;
            })
            .catch(() => remove(grant));
        });
      }
      if (!(await authorized(grant))) {
        remove(grant);
        error((await options.isAuthorized(request)) ? 410 : 401, "面板授权已失效，请重新打开。");
      }
      return {
        instanceId: id,
        src: ASSETS + asset + "/" + app.entry.split("/").map(encodeURIComponent).join("/"),
        expiresAt: grant.expiresAt,
        context,
        limitations: panel.compatibility.reasons,
      };
    } finally {
      preparing.delete(preparation);
    }
  }
  async function call(grant: Grant, input: Record<string, unknown>) {
    return panelExecutionGate.run(
      { appId: grant.app.id, projectPath: options.bindingCwd ?? options.cwd },
      () => callAdmitted(grant, input),
    );
  }
  async function callAdmitted(grant: Grant, input: Record<string, unknown>) {
    if (!(await authorized(grant))) error(410, "面板授权已失效，请重新打开。");
    if (Object.keys(input).some((key) => !["method", "params"].includes(key)))
      error(400, "面板调用参数无效。");
    const method = input.method,
      params = input.params;
    if (typeof method !== "string" || !METHODS.includes(method))
      error(501, "这个面板功能尚未接入网页版，请在桌面客户端使用：" + String(method).slice(0, 80));
    const transfer = [
      "resources.upload.write",
      "resources.read",
      "process.write",
      "process.get",
    ].includes(method);
    const history = (transfer ? grant.transfers : grant.calls).filter(
      (time) => time > now() - 60000,
    );
    if (history.length >= (transfer ? 2048 : 240))
      throw new PanelBridgeError(
        "RATE_LIMITED",
        "面板请求过于频繁。",
        Math.max(1, history[0]! + 60000 - now()),
      );
    history.push(now());
    if (transfer) grant.transfers = history;
    else grant.calls = history;
    if (method === "context.get") return grant.context;
    if (method.startsWith("tasks.")) return dispatchToolJobs(grant, method, params);
    if (method.startsWith("tools.")) {
      const name = (params as { name?: unknown } | undefined)?.name;
      if (typeof name !== "string" || !grant.app.agent?.tools.some((tool) => tool.name === name))
        error(403, "面板未声明这个 Agent 工具。");
      if (method === "tools.register") grant.registeredTools.add(name);
      else grant.registeredTools.delete(name);
      return true;
    }
    const permission = methodPermission(method);
    if (!grant.app.permissions.includes(permission as never)) error(403, "面板未声明这个权限。");
    if (method.startsWith("automations.")) {
      if (!options.automations) error(501, "当前执行环境尚未接入面板自动化。");
      if (
        !grant.app.permissions.includes("context.workspace") ||
        !grant.app.permissions.includes("context.session") ||
        typeof grant.context.sessionId !== "string"
      )
        error(403, "自动化需要已绑定的项目与对话。");
      return options.automations.call(
        {
          appId: grant.app.id,
          cwd: options.cwd,
          sessionId: grant.context.sessionId,
          revision: grant.revision,
          isAuthorized: () => authorized(grant),
        },
        method,
        params,
      );
    }
    const processOwner = {
      guestId: grant.guestId,
      appId: grant.app.id,
      appTitle: grant.app.title.default,
      revision: grant.revision,
      send: (event: "process.output" | "process.exit", payload: Record<string, unknown>) =>
        emit(grant, event, payload),
    };
    if (method.startsWith("resources.")) {
      if (method === "resources.open") {
        const value = params as { assetId?: unknown } | null;
        if (
          !value ||
          Object.keys(value).some((key) => key !== "assetId") ||
          typeof value.assetId !== "string" ||
          !/^(?:asset|external)-[a-f0-9]{64}$/.test(value.assetId)
        )
          error(400, "文件资源标识无效。");
        const asset = await resources.get(
          { appId: grant.app.id, projectPath: options.bindingCwd ?? options.cwd },
          value.assetId,
        );
        if (!(await authorized(grant))) error(410, "面板授权已失效。");
        return {
          effect: "resources.open",
          asset,
          url: `${ROOT}${grant.id}/resources/${asset.id}`,
        };
      }
      if (
        [
          "resources.materialize",
          "resources.capture",
          "resources.references.create",
          "resources.references.relink",
        ].includes(method) &&
        !grant.app.permissions.includes("process")
      )
        error(403, "资源工具交接需要process权限。");
      return resources.dispatch(
        { appId: grant.app.id, projectPath: options.bindingCwd ?? options.cwd },
        method,
        params,
        { resolveDirectory: (handle) => processes.directoryPath(processOwner, handle) },
      );
    }
    if (method === "credentials.cookies.listForTask") {
      const value = await cookieAccess(grant).list((params as { url: string })?.url);
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      return value;
    }
    if (method === "credentials.cookies.authorizeProcess") {
      const value = params as {
        credentialId?: unknown;
        url?: unknown;
        revision?: unknown;
        executableHandle?: unknown;
      };
      const selection = taskCookieSelection({
        credentialId: value?.credentialId,
        url: value?.url,
        revision: value?.revision,
      });
      const access = cookieAccess(grant);
      if (!access.materialize) error(501, "当前 Host 不支持临时进程账号授权。");
      const executable = processes.executableName(processOwner, value.executableHandle);
      const account = await access.check(selection);
      if (
        !(await confirm(
          grant,
          "允许程序使用这个已保存账号？",
          `程序：${executable}\n账号：${account.label}\n站点：${new URL(selection.url).hostname}\n登录信息仅通过私密文件交给所选程序；关闭页面或撤销授权会停止使用。`,
        ))
      )
        return { authorized: false, cancelled: true };
      const validate = async () => {
        await access.check(selection);
        if (!(await authorized(grant))) error(410, "面板授权已失效。");
      };
      await validate();
      const lease = await access.materialize(selection);
      try {
        await validate();
        const sealed = await processes.grantFileArgument(processOwner, {
          executableHandle: value.executableHandle,
          argumentName: "--cookies",
          path: lease.path,
          validate,
          cleanup: () => {
            void lease.cleanup().catch(() => {});
          },
        });
        return { authorized: true, fileArgumentHandle: sealed.handle, count: lease.count };
      } catch (cause) {
        await lease.cleanup();
        throw cause;
      }
    }
    if (method === "credentials.connections.list") return panelConnections(options.cwd);
    if (method === "credentials.connections.authorizeProcess") {
      if (!grant.app.permissions.includes("process")) error(403, "连接交接需要process权限。");
      const value = params as {
        connectionIds?: unknown;
        executableHandle?: unknown;
        argumentName?: unknown;
      };
      const ids = panelConnectionIds(value?.connectionIds);
      if (typeof value.executableHandle !== "string" || typeof value.argumentName !== "string")
        error(400, "连接交接参数无效。");
      if (!(await confirm(grant, "允许面板工具使用这些连接？", ids.join(", "))))
        error(403, "已取消连接交接。");
      const sealed = await materializePanelConnections(
        join(options.dataDir, "panel-sealed"),
        options.cwd,
        ids,
      );
      try {
        return await processes.grantFileArgument(processOwner, {
          executableHandle: value.executableHandle,
          argumentName: value.argumentName,
          path: sealed.path,
          cleanup: sealed.cleanup,
        });
      } catch (error) {
        sealed.cleanup();
        throw error;
      }
    }
    if (method.startsWith("agent.task.")) {
      if (!agentTasks) error(501, "当前宿主未提供独立面板任务。");
      if (
        method === "agent.task.start" &&
        !(await confirm(
          grant,
          `启动 ${grant.app.title.default} 的 AI 任务？`,
          String((params as { prompt?: unknown })?.prompt ?? "").slice(0, 8000),
        ))
      )
        error(403, "你取消了面板 AI 任务。");
      return agentTasks.call(taskScope(grant), method, params);
    }
    if (method.startsWith("process.") || method.startsWith("filesystem.")) {
      const owner = {
        guestId: grant.guestId,
        appId: grant.app.id,
        appTitle: grant.app.title.default,
        revision: grant.revision,
        send: (event: "process.output" | "process.exit", payload: Record<string, unknown>) =>
          emit(grant, event, payload),
      };
      if (method === "process.find") return processes.findExecutable(owner, params);
      if (method === "process.info") return panelProcessInfo();
      if (method === "process.resolveEntry") return processes.resolveEntry(owner, params);
      if (method === "process.get") return processes.get(owner, params);
      if (method === "process.write") return processes.write(owner, params);
      if (method === "process.end") return processes.end(owner, params);
      if (method === "process.spawn") return processes.start(owner, params);
      if (method === "process.cancel") return processes.cancel(owner, params);
      if (method === "filesystem.openDirectory") {
        const handle = (params as { handle?: unknown })?.handle;
        const path = processes.directoryPath(owner, handle);
        return {
          effect: method,
          path,
          opened: false,
          url: `${ROOT}${grant.id}/directory/${handle}`,
        };
      }
      if (method === "filesystem.restoreDirectory") {
        await options.authorizePanelDirectory?.(
          grant.app,
          options.bindingCwd ?? options.cwd,
          options.cwd,
        );
        const saved = directoryBookmarks.restore(
          grant.app.id,
          options.bindingCwd ?? options.cwd,
          (params as { bookmark?: unknown } | null)?.bookmark,
        );
        if (
          !options.authorizePanelDirectory &&
          saved !== (await realpath(options.cwd)) &&
          saved !== (await realpath(join(options.cwd, "downloads")))
        )
          throw new PanelBridgeError("PERMISSION_DENIED", "Saved server directory is unavailable");
        const restored = await processes.grantDirectory(owner, saved);
        await options.authorizePanelDirectory?.(
          grant.app,
          options.bindingCwd ?? options.cwd,
          options.cwd,
        );
        directoryBookmarks.restore(
          grant.app.id,
          options.bindingCwd ?? options.cwd,
          (params as { bookmark?: unknown } | null)?.bookmark,
        );
        return { ...restored, bookmark: (params as { bookmark: string }).bookmark };
      }
      const name =
        method === "filesystem.pickDirectory" ? "downloads" : (params as { name?: unknown })?.name;
      const directory =
        name === "project"
          ? options.cwd
          : name === "downloads"
            ? join(options.cwd, "downloads")
            : name === "user-bin"
              ? join(options.dataDir, "panel-bin")
              : name === "app-data"
                ? panelDataDirectory(grant.app.id)
                : undefined;
      if (!directory) error(400, "不支持这个服务端目录。");
      if (
        method === "filesystem.pickDirectory" &&
        !(await confirm(grant, "使用服务端下载目录？", directory))
      )
        return null;
      await options.authorizePanelDirectory?.(
        grant.app,
        options.bindingCwd ?? options.cwd,
        options.cwd,
      );
      if (name !== "project") await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      const selected = await processes.grantDirectory(owner, directory);
      if (method !== "filesystem.pickDirectory" && !["downloads", "project"].includes(String(name)))
        return selected;
      const bookmark = directoryBookmarks.remember(
        grant.app.id,
        options.bindingCwd ?? options.cwd,
        selected.path,
      );
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      return { ...selected, bookmark };
    }
    if (["external.open", "agent.submitPrompt", "notifications.send"].includes(method)) {
      if (!grant.app.permissions.includes(method as never)) error(403, "面板未声明这个权限。");
      const value = params as Record<string, unknown> | undefined;
      if (method === "external.open") {
        let url: URL;
        try {
          url = new URL(String(value?.url));
        } catch {
          return error(400, "链接格式无效。");
        }
        if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048)
          error(400, "面板只能请求打开 HTTPS 链接。");
        return { effect: method, url: url.href };
      }
      if (method === "agent.submitPrompt") {
        if (!grant.context.sessionId) error(409, "请先选择一个对话。");
        if (
          typeof value?.prompt !== "string" ||
          !value.prompt.trim() ||
          value.prompt.length > 20000
        )
          error(400, "面板任务内容无效。");
        if (
          value.displayText !== undefined &&
          (typeof value.displayText !== "string" ||
            !value.displayText.trim() ||
            value.displayText.length > 20000)
        )
          error(400, "面板任务显示内容无效。");
        return {
          effect: method,
          prompt: value.prompt,
          sessionId: grant.context.sessionId,
          ...(value.displayText ? { displayText: value.displayText } : {}),
        };
      }
      if (
        typeof value?.body !== "string" ||
        !value.body.trim() ||
        value.body.length > 500 ||
        (value.title !== undefined &&
          (typeof value.title !== "string" || !value.title.trim() || value.title.length > 80))
      )
        error(400, "面板通知内容无效。");
      return { effect: method, title: value.title ?? grant.app.title.default, body: value.body };
    }
    return services.call(
      {
        appId: grant.app.id,
        cwd: options.cwd,
        projectPath: options.bindingCwd ?? options.cwd,
        permissions: grant.app.permissions,
        isAuthorized: () => authorized(grant),
      },
      method,
      params,
    );
  }
  return {
    activeTaskCount: () =>
      (agentTasks?.activeTaskCount?.() ?? 0) +
      (toolJobs?.activeCount() ?? 0) +
      (options.sharedToolJobs?.activeCount(options.bindingCwd ?? options.cwd) ?? 0),
    async panelAction(
      ownerId: string,
      sessionId: string,
      input: Record<string, unknown>,
    ): Promise<unknown> {
      const candidates: Grant[] = [];
      for (const grant of grants.values()) {
        if (
          grant.owner === ownerId &&
          grant.context.sessionId === sessionId &&
          (await authorized(grant))
        )
          candidates.push(grant);
      }
      if (input.action === "list")
        return {
          ok: true,
          panels: candidates.map((grant) => ({
            id: `panel-app:${grant.app.id}`,
            title: grant.app.title.default,
            source: "panel-app",
          })),
        };
      const grant = candidates
        .reverse()
        .find(
          (item) => input.panelId === item.app.id || input.panelId === `panel-app:${item.app.id}`,
        );
      if (!grant) return { ok: false, detail: "请先在此对话中打开相应面板。" };
      return onPanelAction(taskScope(grant), input);
    },
    ownsAssets(request: IncomingMessage): boolean {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      return (
        pathname.startsWith(ASSETS) && assets.has(pathname.slice(ASSETS.length).split("/", 1)[0]!)
      );
    },
    cancelOwner,
    invalidate(appId?: string) {
      generation++;
      for (const preparation of preparingTools)
        if (!appId || preparation.appId === appId) preparation.controller.abort();
      for (const grant of grants.values()) if (!appId || grant.app.id === appId) remove(grant);
      const sharedInvalidation = options.sharedToolJobs?.invalidate(
        options.bindingCwd ?? options.cwd,
        appId,
      );
      if (!toolJobs) return sharedInvalidation ?? Promise.resolve();
      const appIds = appId
        ? [appId]
        : [...new Set([...jobOwners.values()].map((record) => record.scope.appId))];
      return Promise.all([sharedInvalidation, ...appIds.map((id) => toolJobs!.cancelApp(id))]).then(
        () => undefined,
      );
    },
    async close() {
      closed = true;
      for (const preparation of preparingTools) preparation.controller.abort();
      clearInterval(reaper);
      for (const grant of grants.values()) remove(grant);
      assets.clear();
      for (const preparation of preparing) preparation.cancelled = true;
      try {
        await toolJobs?.shutdown();
        await taskCookies?.shutdown();
      } finally {
        processes.close();
        await Promise.all([resources.shutdown(), Promise.resolve(agentTasks?.close())]);
      }
    },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith(ROOT)) return false;
      let activeGrant: Grant | undefined;
      try {
        const currentOwner = await options.ownerId(request);
        if (!currentOwner || !(await options.isAuthorized(request))) error(401, "请先登录。");
        if (url.pathname === ROOT + "prepare" && request.method === "POST") {
          json(response, 200, await prepare(request, await body(request)));
          return true;
        }
        const directoryMatch =
          /^\/api\/v1\/panels\/runtime\/([\w-]+)\/directory\/([a-f0-9-]{36})$/.exec(url.pathname);
        const resourceMatch =
          /^\/api\/v1\/panels\/runtime\/([\w-]+)\/resources\/((?:asset|external)-[a-f0-9]{64})$/.exec(
            url.pathname,
          );
        const match =
          /^\/api\/v1\/panels\/runtime\/([\w-]+)(?:\/(call|renew|events|confirm|tool-results))?$/.exec(
            url.pathname,
          ) ??
          directoryMatch ??
          resourceMatch;
        const grant = match && grants.get(match[1]!);
        if (!grant) error(410, "面板连接已失效，请关闭后重新打开。");
        if (currentOwner !== grant.owner) error(403, "这个面板属于另一个登录会话。");
        activeGrant = grant;
        if (!(await authorized(grant))) error(410, "面板连接已失效，请关闭后重新打开。");
        if (resourceMatch) {
          if (!grant.app.permissions.includes("resources")) error(403, "面板未声明资源权限。");
          if (
            [...url.searchParams.keys()].some((key) => !["download", "workspace"].includes(key)) ||
            url.searchParams.getAll("download").length > 1 ||
            url.searchParams.getAll("workspace").length > 1 ||
            (url.searchParams.has("download") && url.searchParams.get("download") !== "1") ||
            (url.searchParams.has("workspace") && url.searchParams.get("workspace") !== options.cwd)
          )
            error(400, "文件访问参数无效。");
          await servePanelResource(request, response, {
            service: resources,
            scope: { appId: grant.app.id, projectPath: options.bindingCwd ?? options.cwd },
            id: resourceMatch[2]!,
            download: url.searchParams.get("download") === "1",
            isAuthorized: async () =>
              currentOwner === grant.owner &&
              (await options.isAuthorized(request)) &&
              (await authorized(grant)),
          });
        } else if (directoryMatch) {
          if (!grant.app.permissions.includes("process")) error(403, "面板未声明这个权限。");
          const root = processes.directoryPath(
            {
              guestId: grant.guestId,
              appId: grant.app.id,
              appTitle: grant.app.title.default,
              revision: grant.revision,
              send: () => {},
            },
            directoryMatch[2],
          );
          await handlePanelProcessDirectory(request, response, {
            root,
            baseUrl: url.pathname,
            linkPrefix: publicPathPrefix,
            workspace: options.cwd,
            isAuthorized: () => authorized(grant),
          });
        } else if (request.method === "DELETE" && !match[2]) {
          remove(grant);
          json(response, 200, { closed: true });
        } else if (request.method === "POST" && match[2] === "renew") {
          const input = await body(request);
          if (Object.keys(input).length) error(400, "续期参数无效。");
          if (!(await authorized(grant))) error(410, "面板授权已失效。");
          grant.expiresAt = now() + GRANT_TTL;
          json(response, 200, { expiresAt: grant.expiresAt });
        } else if (request.method === "GET" && match[2] === "events") {
          const after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0 || after > grant.eventCounter)
            error(400, "事件游标无效。");
          grant.events = grant.events.filter((entry) => entry.id > after);
          grant.eventBytes = grant.events.reduce(
            (total, entry) => total + Buffer.byteLength(JSON.stringify(entry.payload) ?? "null"),
            0,
          );
          const batch = grant.events.slice(0, 128);
          json(response, 200, { events: batch, cursor: batch.at(-1)?.id ?? after });
        } else if (request.method === "POST" && match[2] === "confirm") {
          const input = await body(request);
          const pending =
            typeof input.requestId === "string" && grant.confirmations.get(input.requestId);
          if (
            !pending ||
            typeof input.allowed !== "boolean" ||
            Object.keys(input).some((key) => !["requestId", "allowed"].includes(key))
          )
            error(400, "找不到这个待确认操作。");
          if (!(await authorized(grant))) error(410, "面板授权已失效。");
          pending.finish(input.allowed);
          json(response, 200, { accepted: true, allowed: pending.result });
        } else if (request.method === "POST" && match[2] === "tool-results") {
          const input = await body(request);
          const pending =
            typeof input.requestId === "string" && grant.toolCalls.get(input.requestId);
          if (
            !pending ||
            Object.keys(input).some((key) => !["requestId", "result", "error"].includes(key)) ||
            (input.error !== undefined && typeof input.error !== "string")
          )
            error(400, "找不到这个面板工具调用。");
          if (Buffer.byteLength(JSON.stringify(input)) > 512 * 1024)
            error(413, "面板工具结果过大。");
          if (!(await authorized(grant))) error(410, "面板授权已失效。");
          pending.finish({
            result: input.result,
            error: typeof input.error === "string" ? input.error.slice(0, 1000) : undefined,
          });
          json(response, 200, { accepted: true });
        } else if (request.method === "POST" && match[2] === "call") {
          const input = await body(request);
          const value = await call(grant, input);
          if (!(await authorized(grant))) error(410, "面板授权已失效，请重新打开。");
          const resultLimit =
            typeof input.method === "string" && input.method.startsWith("tasks.")
              ? toolJobLimits.maxRecordBytes + 128 * 1024
              : 3 * 1024 * 1024;
          if (Buffer.byteLength(JSON.stringify(value) ?? "null") > resultLimit)
            throw new PanelBridgeError(
              "RESULT_TOO_LARGE",
              "Panel result exceeds the response limit",
            );
          json(response, 200, value);
        } else error(405, "不支持这个面板请求。");
      } catch (cause) {
        let status =
          cause instanceof PanelManagementError || cause instanceof PanelExecutionBusyError
            ? cause.status
            : cause instanceof PanelBridgeError && cause.code === "RATE_LIMITED"
              ? 429
              : 400;
        if (activeGrant && !(await options.isAuthorized(request))) status = 401;
        else if (activeGrant && !(await authorized(activeGrant))) status = 410;
        json(response, status, {
          error: cause instanceof Error ? cause.message : "面板请求失败。",
          code:
            status === 410
              ? "REVOKED"
              : status === 403
                ? "PERMISSION_DENIED"
                : status === 501
                  ? "NOT_SUPPORTED"
                  : panelBridgeFailure(cause).__codeshellPanelError.code,
          ...(cause instanceof PanelBridgeError && cause.retryAfterMs !== undefined
            ? { retryAfterMs: cause.retryAfterMs }
            : {}),
        });
      }
      return true;
    },
    async handleAssets(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (!pathname.startsWith(ASSETS)) return false;
      const parts = pathname.slice(ASSETS.length).split("/"),
        grant = assets.get(parts.shift()!);
      // Consume all asset routes, including stale grants, instead of falling
      // through to the authenticated SPA or another workspace's runtime.
      if (!grant) {
        json(response, 404, { error: "面板资源授权不存在或已失效。" });
        return true;
      }
      try {
        if (!(await authorized(grant))) error(410, "面板授权已失效，请重新打开。");
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? ""))
          error(405, "面板资源只读。");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (request.method === "OPTIONS") {
          response.writeHead(204, { "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" });
          response.end();
          return true;
        }
        const path = parts.map(decodeURIComponent).join("/");
        let bytes: Buffer;
        if (path === "_codeshell_bridge.js")
          bytes = Buffer.from(bridgeScript(grant.id, grant.origin));
        else {
          if (!grant.files.has(path)) error(404, "找不到面板资源。");
          bytes = await readAsset(grant.root, path);
          if (digest(bytes) !== grant.files.get(path)) {
            remove(grant);
            error(409, "面板文件发生变化，请重新安装后打开。");
          }
        }
        // Relative source expressions remain tied to the resource response origin,
        // including when the public site is behind HTTPS termination.
        const source = publicPathPrefix + ASSETS + grant.asset + "/";
        if (extname(path).toLowerCase() === ".html") {
          bytes = Buffer.from(injectBridge(bytes.toString("utf8"), source));
          const resourceOrigin = grant.origin;
          const assetSource = resourceOrigin + source;
          response.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; script-src " +
              assetSource +
              "; style-src " +
              assetSource +
              " 'unsafe-inline'; img-src " +
              assetSource +
              " data: blob:; media-src " +
              assetSource +
              " blob:; font-src " +
              assetSource +
              " data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors " +
              resourceOrigin,
          );
          response.setHeader(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), display-capture=()",
          );
        }
        if (!(await authorized(grant))) error(410, "面板授权已失效，请重新打开。");
        response.writeHead(200, {
          "Content-Type": MIME[extname(path).toLowerCase()]!,
          "Content-Length": bytes.length,
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
      } catch (cause) {
        if (!(cause instanceof PanelManagementError) || cause.status === 409) remove(grant);
        json(response, cause instanceof PanelManagementError ? cause.status : 404, {
          error: cause instanceof Error ? cause.message : "面板资源不可用。",
        });
      }
      return true;
    },
  };
}
