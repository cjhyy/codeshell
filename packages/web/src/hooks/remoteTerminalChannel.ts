import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-core";

export type TerminalServerEvent = Extract<
  MobileServerEvent,
  {
    type:
      | "terminal.list.ok"
      | "terminal.opened"
      | "terminal.data"
      | "terminal.exit"
      | "terminal.error";
  }
>;
export type TerminalClientEvent = Extract<MobileClientEvent, { type: `terminal.${string}` }>;

function isTerminalEvent(event: MobileServerEvent): event is TerminalServerEvent {
  return event.type.startsWith("terminal.");
}

/**
 * Terminal traffic shares the authenticated remote socket but none of the chat
 * state, so it bypasses the chat reducer: views subscribe here directly.
 */
export class RemoteTerminalChannel {
  private readonly listeners = new Set<(event: TerminalServerEvent) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private sender?: (event: MobileClientEvent) => boolean;
  private generation = -1;

  /** True when the event belonged to a terminal and was delivered here. */
  accept(event: MobileServerEvent): boolean {
    if (!isTerminalEvent(event)) return false;
    for (const listener of [...this.listeners]) listener(event);
    return true;
  }

  /** Called whenever the socket changes; a new authenticated socket re-attaches views. */
  bind(send: (event: MobileClientEvent) => boolean, online: boolean, generation: number): void {
    this.sender = online ? send : undefined;
    if (!online || generation === this.generation) return;
    this.generation = generation;
    for (const listener of [...this.reconnectListeners]) listener();
  }

  get online(): boolean {
    return this.sender !== undefined;
  }

  send(event: TerminalClientEvent): boolean {
    return this.sender?.(event) ?? false;
  }

  subscribe(listener: (event: TerminalServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fires on every newly authenticated socket (output may have been lost meanwhile). */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }
}

/** Ctrl+<key> for one typed character, as a terminal would send it (phone Ctrl key). */
export function ctrlSequence(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
}
