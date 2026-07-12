import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator.js";

export const PET_SNAPSHOT_CHANNEL = "pet:get-snapshot";
export const PET_EVENT_CHANNEL = "pet:projection-event";

export interface PetIpcAggregator {
  getSnapshot(): DesktopPetProjectionSnapshot;
  subscribe(listener: (event: DesktopPetProjectionEvent) => void): () => void;
}

export interface PetIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
  removeHandler(channel: string): unknown;
}

export interface PetIpcWindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
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
  const unsubscribe = options.aggregator.subscribe((event) => {
    for (const window of options.windows()) {
      if (!window.isDestroyed()) window.webContents.send(PET_EVENT_CHANNEL, event);
    }
  });
  return () => {
    unsubscribe();
    options.ipcMain.removeHandler(PET_SNAPSHOT_CHANNEL);
  };
}
