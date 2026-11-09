import type { ParsedHostAction } from "./browser-driver/intercept.js";

/** Handles one `__host_action__` action for a live worker Session. */
export type HostActionHandler = (
  sessionId: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Registry behind `AgentBridge.setHostActionHandler`. Kept free of Electron so
 * the dispatch contract (reply JSON for every outcome) is unit-tested.
 */
export class HostActionHandlers {
  private readonly handlers = new Map<string, HostActionHandler>();

  /** Register `handler` for `action`; the returned function removes only this registration. */
  set(action: string, handler: HostActionHandler): () => void {
    const registration: HostActionHandler = (sessionId, args) => handler(sessionId, args);
    this.handlers.set(action, registration);
    return () => {
      if (this.handlers.get(action) === registration) this.handlers.delete(action);
    };
  }

  /** Run the action and return the `decision.answer` JSON; never rejects. */
  async dispatch(parsed: ParsedHostAction): Promise<string> {
    try {
      if (!parsed.sessionId) throw new Error("host action requires sessionId");
      const handler = this.handlers.get(parsed.action);
      if (!handler) throw new Error(`unknown host action: ${parsed.action}`);
      const result = await handler(parsed.sessionId, parsed.args);
      return JSON.stringify(result) ?? "null";
    } catch (e) {
      return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
