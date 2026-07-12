import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetNavigationRequest,
  PetNavigationResult,
} from "./pet-state-aggregator.js";

export const PET_SNAPSHOT_CHANNEL = "pet:get-snapshot";
export const PET_EVENT_CHANNEL = "pet:projection-event";
export const PET_OPEN_SESSION_CHANNEL = "pet:open-session";

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

export function registerPetIpc(options: {
  ipcMain: PetIpcMainLike;
  aggregator: PetIpcAggregator;
  windows: () => readonly PetIpcWindowLike[];
}): () => void {
  options.ipcMain.handle(PET_SNAPSHOT_CHANNEL, (_event, ...args) => {
    if (args.length > 0) throw new Error("pet:getSnapshot does not accept arguments");
    return options.aggregator.getSnapshot();
  });
  options.ipcMain.handle(PET_OPEN_SESSION_CHANNEL, (_event, ...args) => {
    if (args.length !== 1) throw new Error("invalid navigation request");
    return options.aggregator.resolveNavigation(parseNavigationRequest(args[0]));
  });
  const unsubscribe = options.aggregator.subscribe((event) => {
    for (const window of options.windows()) {
      if (!window.isDestroyed()) window.webContents.send(PET_EVENT_CHANNEL, event);
    }
  });
  return () => {
    unsubscribe();
    options.ipcMain.removeHandler(PET_SNAPSHOT_CHANNEL);
    options.ipcMain.removeHandler(PET_OPEN_SESSION_CHANNEL);
  };
}
