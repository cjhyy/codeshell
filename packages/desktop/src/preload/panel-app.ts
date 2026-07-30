import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type PanelAppEvent = "context.changed";
type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

interface AgentToolRequest {
  requestId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

const MAX_AGENT_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_AGENT_TOOL_ERROR_LENGTH = 1_000;

const toolHandlers = new Map<string, ToolHandler>();
const pendingRequests = new Map<
  string,
  { request: AgentToolRequest; timeout: ReturnType<typeof setTimeout> }
>();

function respond(requestId: string, result: unknown, error?: string): void {
  ipcRenderer.send("panel-app:agent-tool-response", {
    requestId,
    ...(error
      ? { ok: false, error: error.slice(0, MAX_AGENT_TOOL_ERROR_LENGTH) }
      : { ok: true, result }),
  });
}

async function executeToolRequest(request: AgentToolRequest): Promise<void> {
  const handler = toolHandlers.get(request.toolName);
  if (!handler) return;
  const pending = pendingRequests.get(request.requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingRequests.delete(request.requestId);
  }
  try {
    const value = await handler(request.arguments);
    const encoded = JSON.stringify(value ?? null);
    if (new TextEncoder().encode(encoded).byteLength > MAX_AGENT_TOOL_RESULT_BYTES) {
      throw new Error("Panel App tool result exceeds the 256 KiB limit");
    }
    respond(request.requestId, JSON.parse(encoded));
  } catch (error) {
    respond(request.requestId, null, error instanceof Error ? error.message : String(error));
  }
}

ipcRenderer.on(
  "panel-app:agent-tool-request",
  (_event: IpcRendererEvent, request: AgentToolRequest) => {
    if (
      !request ||
      typeof request.requestId !== "string" ||
      typeof request.toolName !== "string" ||
      !request.arguments ||
      typeof request.arguments !== "object" ||
      Array.isArray(request.arguments)
    ) {
      return;
    }
    if (toolHandlers.has(request.toolName)) {
      void executeToolRequest(request);
      return;
    }
    const timeout = setTimeout(() => {
      pendingRequests.delete(request.requestId);
      respond(request.requestId, null, `Panel App tool '${request.toolName}' is not registered`);
    }, 5_000);
    pendingRequests.set(request.requestId, { request, timeout });
  },
);

const api = Object.freeze({
  getContext: () => ipcRenderer.invoke("panel-app:get-context"),
  call: (method: string, params?: unknown) => ipcRenderer.invoke("panel-app:call", method, params),
  registerTool: (name: string, handler: ToolHandler) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof handler !== "function") {
      throw new Error("invalid Panel App tool registration");
    }
    if (toolHandlers.has(name)) throw new Error(`Panel App tool '${name}' is already registered`);
    toolHandlers.set(name, handler);
    for (const pending of [...pendingRequests.values()]) {
      if (pending.request.toolName === name) void executeToolRequest(pending.request);
    }
    return () => {
      if (toolHandlers.get(name) === handler) toolHandlers.delete(name);
    };
  },
  on: (event: PanelAppEvent, listener: (payload: unknown) => void) => {
    if (event !== "context.changed" || typeof listener !== "function") {
      throw new Error("unsupported Panel App event");
    }
    const handler = (
      _ipcEvent: IpcRendererEvent,
      message: { event?: unknown; payload?: unknown },
    ) => {
      if (message?.event === event) listener(message.payload);
    };
    ipcRenderer.on("panel-app:event", handler);
    return () => ipcRenderer.removeListener("panel-app:event", handler);
  },
});

contextBridge.exposeInMainWorld("codeshellPanel", api);
