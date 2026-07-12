import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetNavigationRequest,
  PetNavigationResult,
} from "./pet-state-aggregator.js";
import type { PetDispatchCommand, PetDispatchResult } from "./pet-dispatch-service.js";

export const PET_SNAPSHOT_CHANNEL = "pet:get-snapshot";
export const PET_EVENT_CHANNEL = "pet:projection-event";
export const PET_OPEN_SESSION_CHANNEL = "pet:open-session";
export const PET_DISPATCH_CHANNEL = "pet:dispatch";

export interface PetIpcAggregator {
  getSnapshot(): DesktopPetProjectionSnapshot;
  subscribe(listener: (event: DesktopPetProjectionEvent) => void): () => void;
  resolveNavigation(request: PetNavigationRequest): Promise<PetNavigationResult>;
}

export interface PetIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
  removeHandler(channel: string): unknown;
}

export interface PetIpcWindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

export interface PetIpcDispatcher {
  dispatch(command: PetDispatchCommand): Promise<PetDispatchResult>;
}

function parseNavigationRequest(value: unknown): PetNavigationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid navigation request");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "agentSessionId",
    "snapshotVersion",
    "generation",
    "requestId",
    "routeGeneration",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("invalid navigation request");
  }
  if (
    typeof record.agentSessionId !== "string" ||
    !record.agentSessionId ||
    typeof record.snapshotVersion !== "number" ||
    !Number.isSafeInteger(record.snapshotVersion) ||
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    (record.requestId !== undefined && typeof record.requestId !== "string") ||
    (record.routeGeneration !== undefined &&
      (typeof record.routeGeneration !== "number" || !Number.isSafeInteger(record.routeGeneration)))
  ) {
    throw new Error("invalid navigation request");
  }
  return record as unknown as PetNavigationRequest;
}

function parseDispatchCommand(value: unknown): PetDispatchCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid pet command");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") throw new Error("invalid pet command");
  switch (record.type) {
    case "get_global_status":
    case "list_pending":
      if (Object.keys(record).length !== 1) throw new Error("invalid pet command");
      return { type: record.type };
    case "chat":
      if (
        Object.keys(record).some((key) => key !== "type" && key !== "message") ||
        typeof record.message !== "string"
      ) {
        throw new Error("invalid pet command");
      }
      return { type: "chat", message: record.message };
    case "open_session":
      if (Object.keys(record).some((key) => key !== "type" && key !== "target")) {
        throw new Error("invalid pet command");
      }
      return { type: "open_session", target: parseNavigationRequest(record.target) };
    default:
      if (Object.keys(record).length !== 1) throw new Error("invalid pet command");
      return { type: record.type } as PetDispatchCommand;
  }
}

export function registerPetIpc(options: {
  ipcMain: PetIpcMainLike;
  aggregator: PetIpcAggregator;
  windows: () => readonly PetIpcWindowLike[];
  dispatcher?: PetIpcDispatcher;
}): () => void {
  options.ipcMain.handle(PET_SNAPSHOT_CHANNEL, (_event, ...args) => {
    if (args.length > 0) throw new Error("pet:getSnapshot does not accept arguments");
    return options.aggregator.getSnapshot();
  });
  options.ipcMain.handle(PET_OPEN_SESSION_CHANNEL, (_event, ...args) => {
    if (args.length !== 1) throw new Error("invalid navigation request");
    return options.aggregator.resolveNavigation(parseNavigationRequest(args[0]));
  });
  if (options.dispatcher) {
    options.ipcMain.handle(PET_DISPATCH_CHANNEL, (_event, ...args) => {
      if (args.length !== 1) throw new Error("invalid pet command");
      return options.dispatcher!.dispatch(parseDispatchCommand(args[0]));
    });
  }
  const unsubscribe = options.aggregator.subscribe((event) => {
    for (const window of options.windows()) {
      if (!window.isDestroyed()) window.webContents.send(PET_EVENT_CHANNEL, event);
    }
  });
  return () => {
    unsubscribe();
    options.ipcMain.removeHandler(PET_SNAPSHOT_CHANNEL);
    options.ipcMain.removeHandler(PET_OPEN_SESSION_CHANNEL);
    if (options.dispatcher) options.ipcMain.removeHandler(PET_DISPATCH_CHANNEL);
  };
}
