import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  listInstalledPanelApps,
  validateToolArgsStrict,
  type InstalledPanelApp,
} from "@cjhyy/code-shell-core";
import { PanelRuntimeServices } from "./runtime-services.js";
import { handlePanelProcessDirectory } from "./process-files.js";
import {
  PanelAppProcessService,
  panelExecutableDirectories,
  panelProcessInfo,
} from "./process-service.js";
import { PanelManagementError, type PanelManagementOptions } from "./management.js";
import type { PanelSnapshot } from "./types.js";

const ASSETS = "/api/v1/panel-assets/";
const ROOT = "/api/v1/panels/runtime/";
const MAX_FILE = 16 * 1024 * 1024;
const GRANT_TTL = 30 * 60_000;
const METHODS = [
  "context.get",
  "storage.get",
  "storage.set",
  "storage.delete",
  "workspace.info",
  "workspace.list",
  "workspace.readText",
  "workspace.writeText",
  "external.open",
  "agent.submitPrompt",
  "notifications.send",
  "process.find",
  "process.info",
  "process.spawn",
  "process.cancel",
  "filesystem.getKnownDirectory",
  "filesystem.pickDirectory",
  "filesystem.openDirectory",
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
export const panelWebCompatibility: NonNullable<PanelManagementOptions["compatibility"]> = (
  app,
) => ({
  supported: true,
  reasons: [
    ...app.permissions
      .filter((permission) => !PERMISSIONS.has(permission))
      .map((permission) => "网页暂不提供 " + permission + "，对应功能需要桌面客户端。"),
  ],
});

interface Grant {
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
  createAgentTasks?: (hooks: {
    onPanelAction(scope: PanelTaskScope, input: Record<string, unknown>): Promise<unknown>;
  }) => PanelTaskHost;
}
function methodPermission(method: string): string {
  if (method.startsWith("storage.")) return "storage";
  if (method.startsWith("process.") || method.startsWith("filesystem.")) return "process";
  if (method.startsWith("agent.task.")) return "agent.task";
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
      }, 60000);
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
        data.error ? item.reject(new Error(String(data.error))) : item.resolve(data.result);
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
        on: (name, listener) => {
          if (!["context.changed", "process.output", "process.exit", "agent.task.changed", "media.job.changed"].includes(name) || typeof listener !== "function") {
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
  if (
    publicPathPrefix &&
    !/^\/p\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(publicPathPrefix)
  )
    throw new Error("Invalid project public path prefix");
  const grants = new Map<string, Grant>();
  const assets = new Map<string, Grant>();
  const now = options.now ?? Date.now;
  const services = new PanelRuntimeServices({ dataDir: options.dataDir });
  const installed = options.listInstalled ?? listInstalledPanelApps;
  let closed = false;
  let generation = 0;
  let nextGuest = 0;
  const byGuest = new Map<number, Grant>();
  const processes = new PanelAppProcessService({
    approvalScope: "guest",
    extraPathDirectories: () =>
      panelExecutableDirectories(join(options.dataDir, "panel-bin"), { home: homedir() }),
    isOwnerAuthorized: async (owner) => {
      const grant = byGuest.get(owner.guestId);
      return !!grant && (await authorized(grant));
    },
    confirmExecution: async (input) => {
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
  const agentTasks = options.createAgentTasks?.({ onPanelAction }) ?? options.agentTasks;
  const reaper = setInterval(() => {
    for (const grant of grants.values()) void authorized(grant).catch(() => remove(grant));
  }, 60_000);
  reaper.unref();
  const preparing = new Set<{ owner: string; cancelled: boolean }>();
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
    const requestId = randomBytes(18).toString("base64url");
    const value = await new Promise<{ result?: unknown; error?: string }>((done) => {
      const timer = setTimeout(() => finish({ error: "面板工具调用超时。" }), 45_000);
      timer.unref();
      const finish = (result: { result?: unknown; error?: string }) => {
        if (!grant.toolCalls.delete(requestId)) return;
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
    for (const preparation of preparing)
      if (preparation.owner === owner) preparation.cancelled = true;
    for (const grant of grants.values()) if (grant.owner === owner) remove(grant);
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
      const root = await realpath(app.installPath),
        info = await lstat(app.installPath);
      if (info.isSymbolicLink() || !info.isDirectory()) error(403, "面板安装目录无效。");
      const files = await snapshotFiles(root, dirname(app.entry));
      if (!files.has(app.entry)) error(404, "找不到面板入口。");
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
        apiVersion: agentTasks ? 9 : 7,
        host: options.host,
        availableMethods: METHODS.filter((method) => {
          if (method.startsWith("agent.task.") && !agentTasks) return false;
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
    if (!(await authorized(grant))) error(410, "面板授权已失效，请重新打开。");
    if (Object.keys(input).some((key) => !["method", "params"].includes(key)))
      error(400, "面板调用参数无效。");
    const method = input.method,
      params = input.params;
    if (typeof method !== "string" || !METHODS.includes(method))
      error(501, "这个面板功能尚未接入网页版，请在桌面客户端使用：" + String(method).slice(0, 80));
    grant.calls = grant.calls.filter((time) => time > now() - 60_000);
    if (grant.calls.length >= 240) error(429, "面板请求过于频繁。");
    grant.calls.push(now());
    if (method === "context.get") return grant.context;
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
      const name =
        method === "filesystem.pickDirectory" ? "downloads" : (params as { name?: unknown })?.name;
      const directory =
        name === "downloads"
          ? join(options.cwd, "downloads")
          : name === "user-bin"
            ? join(options.dataDir, "panel-bin")
            : name === "app-data"
              ? join(
                  options.dataDir,
                  "panel-data",
                  grant.app.id,
                  digest(Buffer.from(options.bindingCwd ?? options.cwd)).slice(0, 24),
                )
              : undefined;
      if (!directory) error(400, "不支持这个服务端目录。");
      if (
        method === "filesystem.pickDirectory" &&
        !(await confirm(grant, "使用服务端下载目录？", directory))
      )
        return null;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await authorized(grant))) error(410, "面板授权已失效。");
      return processes.grantDirectory(owner, directory);
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
    activeTaskCount: () => agentTasks?.activeTaskCount?.() ?? 0,
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
      for (const grant of grants.values()) if (!appId || grant.app.id === appId) remove(grant);
    },
    close() {
      closed = true;
      clearInterval(reaper);
      for (const grant of grants.values()) remove(grant);
      processes.close();
      void agentTasks?.close();
      assets.clear();
      for (const preparation of preparing) preparation.cancelled = true;
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
        const match =
          /^\/api\/v1\/panels\/runtime\/([\w-]+)(?:\/(call|renew|events|confirm|tool-results))?$/.exec(
            url.pathname,
          ) ?? directoryMatch;
        const grant = match && grants.get(match[1]!);
        if (!grant) error(410, "面板连接已失效，请关闭后重新打开。");
        if (currentOwner !== grant.owner) error(403, "这个面板属于另一个登录会话。");
        activeGrant = grant;
        if (!(await authorized(grant))) error(410, "面板连接已失效，请关闭后重新打开。");
        if (directoryMatch) {
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
          const value = await call(grant, await body(request));
          if (!(await authorized(grant))) error(410, "面板授权已失效，请重新打开。");
          json(response, 200, value);
        } else error(405, "不支持这个面板请求。");
      } catch (cause) {
        let status = cause instanceof PanelManagementError ? cause.status : 400;
        if (activeGrant && !(await options.isAuthorized(request))) status = 401;
        else if (activeGrant && !(await authorized(activeGrant))) status = 410;
        json(response, status, {
          error: cause instanceof Error ? cause.message : "面板请求失败。",
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
