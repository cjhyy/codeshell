import {
  buildHostActionReply,
  parseHostActionEnvelope,
  parseHostActionLine,
  type ParsedHostAction,
} from "./browser-driver/intercept.js";

/**
 * Handles one `__host_action__` action for a live worker Session. Must resolve
 * to a JSON-serializable plain object (conventionally `{ ok: true, ... }`):
 * Core rejects any other reply shape as malformed. Throw to report failure;
 * the message becomes `{ ok: false, error }`.
 */
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

  /**
   * Consume a `__host_action__` line and answer it asynchronously through
   * `sendLine`. Once the host runtime routed the line here it must never reach
   * the renderer, so a malformed request is still consumed and answered
   * `{ ok:false, error:"malformed host action request" }`. Returns false only
   * for lines that are not host-action requests at all.
   */
  intercept(
    line: string,
    sendLine: (line: string) => void,
    log: (error: unknown) => void,
  ): boolean {
    const parsed = parseHostActionLine(line);
    if (!parsed) {
      const envelope = parseHostActionEnvelope(line);
      if (!envelope) return false;
      const malformed = JSON.stringify({ ok: false, error: "malformed host action request" });
      sendLine(buildHostActionReply(envelope, malformed));
      return true;
    }
    void this.dispatch(parsed)
      .then((resultJson) => sendLine(buildHostActionReply(parsed, resultJson)))
      .catch(log);
    return true;
  }

  /** Run the action and return the `decision.answer` JSON; never rejects. */
  async dispatch(parsed: ParsedHostAction): Promise<string> {
    try {
      // Safety net only: classifyHostRequest (host-requests.ts) already drops
      // approval requests without a sessionId before they are routed here.
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
