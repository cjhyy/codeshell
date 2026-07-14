import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentBridge } from "./agent-bridge.js";
import type { PluginPanelProtocolResource } from "./plugin-panel-protocol.js";
import { preparePluginPanel } from "./plugin-panel-protocol.js";
import {
  PLUGIN_PANEL_API_VERSION,
  type PluginPanelBindInput,
  type PluginPanelHostContext,
} from "../shared/plugin-panels.js";

const MAX_PARAMS_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_CALLS_PER_WINDOW = 30;
const RATE_WINDOW_MS = 10_000;
const CALL_TIMEOUT_MS = 15_000;
const STORAGE_QUOTA_BYTES = 256 * 1024;

interface GuestBinding {
  guest: WebContents;
  ownerWindowId: number;
  resource: PluginPanelProtocolResource;
  context: PluginPanelHostContext;
  callTimes: number[];
  bucket?: string;
}

export interface PluginPanelBridgeOptions {
  isTrustedHost(sender: WebContents): boolean;
  getAgentBridge(): AgentBridge | null;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf-8");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("plugin panel call timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class PluginPanelBridge {
  private readonly guests = new Map<number, GuestBinding>();

  constructor(private readonly options: PluginPanelBridgeOptions) {}

  registerIpc(): void {
    ipcMain.handle("plugin-panels:prepare", (event, id: string) => {
      this.assertTrustedHost(event.sender);
      if (typeof id !== "string" || !id.startsWith("plugin:")) {
        throw new Error("invalid plugin panel id");
      }
      return preparePluginPanel(id);
    });
    ipcMain.handle("plugin-panels:bind", (event, input: PluginPanelBindInput) => {
      this.assertTrustedHost(event.sender);
      return this.bindGuest(event.sender, input);
    });
    ipcMain.handle("plugin-panel:get-context", (event) => this.contextFor(event.sender));
    ipcMain.handle("plugin-panel:call", (event, method: string, params?: unknown) =>
      this.call(event.sender, method, params),
    );
  }

  registerGuest(
    guest: WebContents,
    owner: BrowserWindow,
    resource: PluginPanelProtocolResource,
  ): void {
    const binding: GuestBinding = {
      guest,
      ownerWindowId: owner.id,
      resource,
      context: {
        panelId: resource.descriptor.panelId,
        pluginId: resource.descriptor.installKey,
        visible: false,
        theme: "system",
        locale: "en",
        apiVersion: PLUGIN_PANEL_API_VERSION,
      },
      callTimes: [],
    };
    this.guests.set(guest.id, binding);
    guest.once("destroyed", () => this.revokeGuest(guest.id));
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-navigate", (event, url) => {
      const expected = new URL(
        `csplugin://${resource.descriptor.hostId}/${resource.entry
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}`,
      ).toString();
      try {
        if (new URL(url).toString() !== expected) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
  }

  revokeGuest(guestId: number): void {
    this.guests.delete(guestId);
  }

  revokeInstallKey(installKey: string): void {
    for (const [guestId, binding] of this.guests) {
      if (binding.resource.descriptor.installKey !== installKey) continue;
      this.guests.delete(guestId);
      if (!binding.guest.isDestroyed()) binding.guest.stop();
    }
  }

  private assertTrustedHost(sender: WebContents): void {
    if (!this.options.isTrustedHost(sender)) throw new Error("untrusted plugin panel host sender");
  }

  private bindGuest(sender: WebContents, input: PluginPanelBindInput): boolean {
    if (
      !input ||
      !Number.isSafeInteger(input.guestId) ||
      input.guestId <= 0 ||
      typeof input.panelId !== "string" ||
      typeof input.tabId !== "string" ||
      input.tabId.length === 0 ||
      input.tabId.length > 512
    ) {
      throw new Error("invalid plugin panel binding");
    }
    const binding = this.guests.get(input.guestId);
    const owner = BrowserWindow.fromWebContents(sender);
    if (!binding || !owner || binding.ownerWindowId !== owner.id) {
      throw new Error("plugin panel guest does not belong to this window");
    }
    if (binding.resource.descriptor.id !== input.panelId) {
      throw new Error("plugin panel descriptor does not match attached guest");
    }
    if (
      typeof input.bucket !== "string" ||
      input.bucket.length === 0 ||
      input.bucket.length > 512
    ) {
      throw new Error("invalid plugin panel bucket");
    }
    if (
      (input.sessionId != null &&
        (typeof input.sessionId !== "string" || input.sessionId.length > 256)) ||
      (input.cwd != null && (typeof input.cwd !== "string" || input.cwd.length > 4096))
    ) {
      throw new Error("invalid plugin panel context");
    }
    binding.bucket = input.bucket;
    binding.context = {
      panelId: binding.resource.descriptor.panelId,
      pluginId: binding.resource.descriptor.installKey,
      visible: input.visible === true,
      theme: input.theme === "light" || input.theme === "dark" ? input.theme : "system",
      locale: typeof input.locale === "string" ? input.locale.slice(0, 16) : "en",
      apiVersion: PLUGIN_PANEL_API_VERSION,
      ...(binding.resource.descriptor.permissions.includes("context.session") && input.sessionId
        ? { sessionId: input.sessionId, busy: input.busy === true }
        : {}),
      ...(binding.resource.descriptor.permissions.includes("context.workspace") && input.cwd
        ? { cwd: input.cwd, trusted: input.trusted === true }
        : {}),
    };
    if (!binding.guest.isDestroyed()) {
      binding.guest.send("plugin-panel:event", {
        event: "context.changed",
        payload: binding.context,
      });
    }
    return true;
  }

  private bindingFor(sender: WebContents): GuestBinding {
    const binding = this.guests.get(sender.id);
    if (!binding || binding.guest !== sender) throw new Error("plugin panel scope is not bound");
    return binding;
  }

  private contextFor(sender: WebContents): PluginPanelHostContext {
    return { ...this.bindingFor(sender).context };
  }

  private async call(sender: WebContents, method: string, params?: unknown): Promise<unknown> {
    const binding = this.bindingFor(sender);
    if (!binding.bucket) throw new Error("plugin panel scope is not bound");
    if (typeof method !== "string" || method.length > 64) throw new Error("invalid bridge method");
    if (jsonBytes(params) > MAX_PARAMS_BYTES) throw new Error("plugin panel params are too large");
    const now = Date.now();
    binding.callTimes = binding.callTimes.filter((time) => now - time < RATE_WINDOW_MS);
    if (binding.callTimes.length >= MAX_CALLS_PER_WINDOW) {
      throw new Error("plugin panel rate limit exceeded");
    }
    binding.callTimes.push(now);

    const operation = this.dispatch(binding, method, params);
    const result = await withTimeout(operation, CALL_TIMEOUT_MS);
    if (jsonBytes(result) > MAX_RESULT_BYTES) throw new Error("plugin panel result is too large");
    return result;
  }

  private requirePermission(binding: GuestBinding, permission: string): void {
    if (!binding.resource.descriptor.permissions.includes(permission as never)) {
      throw new Error(`plugin panel permission denied: ${permission}`);
    }
  }

  private async dispatch(binding: GuestBinding, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "storage.get":
        this.requirePermission(binding, "storage");
        return this.storageGet(binding, params);
      case "storage.set":
        this.requirePermission(binding, "storage");
        return this.storageSet(binding, params);
      case "storage.delete":
        this.requirePermission(binding, "storage");
        return this.storageDelete(binding, params);
      case "external.open":
        this.requirePermission(binding, "external.open");
        return this.openExternal(binding, params);
      case "agent.submitPrompt":
        this.requirePermission(binding, "agent.submitPrompt");
        return this.submitPrompt(binding, params);
      default:
        throw new Error(`unknown plugin panel method: ${method}`);
    }
  }

  private storagePath(binding: GuestBinding): string {
    const namespace = createHash("sha256")
      .update(binding.resource.descriptor.installKey)
      .update("\0")
      .update(binding.resource.descriptor.panelId)
      .digest("hex");
    return join(app.getPath("userData"), "plugin-panel-storage", `${namespace}.json`);
  }

  private async readStorage(binding: GuestBinding): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(await readFile(this.storagePath(binding), "utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private storageKey(params: unknown): string {
    const key = (params as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(key)) {
      throw new Error("storage key must match [a-zA-Z0-9._-]{1,80}");
    }
    return key;
  }

  private async storageGet(binding: GuestBinding, params: unknown): Promise<unknown> {
    return (await this.readStorage(binding))[this.storageKey(params)] ?? null;
  }

  private async storageSet(binding: GuestBinding, params: unknown): Promise<boolean> {
    const key = this.storageKey(params);
    const value = (params as { value?: unknown }).value;
    const encodedValue = JSON.stringify(value);
    if (encodedValue === undefined)
      throw new Error("plugin panel storage only accepts JSON values");
    const jsonValue = JSON.parse(encodedValue) as unknown;
    const storage = await this.readStorage(binding);
    storage[key] = jsonValue;
    const serialized = `${JSON.stringify(storage)}\n`;
    if (Buffer.byteLength(serialized, "utf-8") > STORAGE_QUOTA_BYTES) {
      throw new Error("plugin panel storage quota exceeded");
    }
    const file = this.storagePath(binding);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serialized, "utf-8");
    return true;
  }

  private async storageDelete(binding: GuestBinding, params: unknown): Promise<boolean> {
    const key = this.storageKey(params);
    const storage = await this.readStorage(binding);
    const existed = Object.prototype.hasOwnProperty.call(storage, key);
    delete storage[key];
    const file = this.storagePath(binding);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(storage)}\n`, "utf-8");
    return existed;
  }

  private async openExternal(binding: GuestBinding, params: unknown): Promise<boolean> {
    const rawUrl = (params as { url?: unknown } | null)?.url;
    let url: URL;
    try {
      url = new URL(typeof rawUrl === "string" ? rawUrl : "");
    } catch {
      throw new Error("external.open only accepts https URLs");
    }
    if (
      typeof rawUrl !== "string" ||
      rawUrl.length > 2048 ||
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error("external.open only accepts https URLs");
    }
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
    const decision = await dialog.showMessageBox(owner, {
      type: "question",
      buttons: ["Open", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: binding.resource.descriptor.title,
      message: "Open this link in your system browser?",
      detail: url.toString(),
      noLink: true,
    });
    if (decision.response !== 0) return false;
    await shell.openExternal(url.toString());
    return true;
  }

  private async submitPrompt(binding: GuestBinding, params: unknown): Promise<unknown> {
    const task = (params as { prompt?: unknown } | null)?.prompt;
    if (typeof task !== "string" || task.trim().length === 0 || task.length > 20_000) {
      throw new Error("agent.submitPrompt requires a non-empty prompt up to 20000 characters");
    }
    const { sessionId, cwd } = binding.context;
    if (!sessionId) throw new Error("agent.submitPrompt requires context.session permission");
    if (binding.context.busy) throw new Error("the target session is busy");
    const bridge = this.options.getAgentBridge();
    if (!bridge) throw new Error("agent worker is unavailable");
    const result = await bridge.requestWorker("agent/run", {
      task: task.trim(),
      sessionId,
      cwd,
      bucket: binding.bucket,
    });
    if (!result.ok) throw new Error(result.message);
    return result.result;
  }
}
