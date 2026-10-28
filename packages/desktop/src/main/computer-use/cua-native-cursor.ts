import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { CuaActivityEvent } from "./cua-activity.js";

type JsonObject = Record<string, unknown>;
interface CursorState {
  session: string;
  position?: { x: number; y: number };
  visualAction?: string;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function cursorState(value: unknown): CursorState | undefined {
  const state = object(value);
  if (typeof state?.session !== "string" || state.session.length > 512) return;
  if (typeof state.enabled !== "boolean") return;
  const position = object(state.position);
  if (state.position === null) return { session: state.session };
  if (
    !position ||
    typeof position.x !== "number" ||
    typeof position.y !== "number" ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    Math.abs(position.x) > 100_000 ||
    Math.abs(position.y) > 100_000
  )
    return;
  const action = object(state.visual_state)?.requested_action;
  return {
    session: state.session,
    position: { x: position.x, y: position.y },
    ...(typeof action === "string" && action.length <= 16 ? { visualAction: action } : {}),
  };
}

function samePoint(a: CursorState["position"], b: CursorState["position"]): boolean {
  return a?.x === b?.x && a?.y === b?.y;
}

/** A separate native connection avoids the official MCP proxy's serial call loop.
 * Only an identity returned by this proxy's own implicit-session query is used.
 * This connection never owns session_begin/end, so closing it cannot reap work. */
export function readNativeCursorState(
  socketPath: string,
  transportSession: string,
  publicSession: string | undefined,
  signal: AbortSignal,
  timeoutMs = 250,
): Promise<CursorState | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (state?: CursorState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(state);
    };
    const abort = (): void => finish();
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.once("error", abort);
    socket.once("close", abort);
    socket.once("connect", () => {
      socket.write(
        JSON.stringify({
          method: "call",
          name: "get_agent_cursor_state",
          session_id: transportSession,
          args: publicSession === undefined ? {} : { session: publicSession },
        }) + "\n",
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65_536) return finish();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const response = object(JSON.parse(buffer.slice(0, end)));
        const result = object(response?.result);
        if (response?.ok !== true || result?.isError === true) return finish();
        const state = cursorState(result?.structuredContent);
        finish(state?.session === (publicSession || transportSession) ? state : undefined);
      } catch {
        finish();
      }
    });
  });
}

interface SamplingAction {
  event: CuaActivityEvent;
  session?: string;
  previous?: CursorState["position"];
  baselineAction?: string;
  expectedAction: string;
  published: boolean;
  controller: AbortController;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  task?: Promise<void>;
}

interface NativeCursorOptions {
  socketPath: string;
  childPid: number | undefined;
  sendMcp: (bytes: Buffer) => Promise<void>;
  emit: (event: CuaActivityEvent) => Promise<unknown>;
  timeoutMs?: number;
  intervalMs?: number;
}

const POSITIONED_TOOLS = new Set([
  "move_cursor",
  "click",
  "double_click",
  "right_click",
  "type_text",
  "scroll",
  "drag",
  "press_key",
]);

/** Advisory positions, never an input source. Registry positions are commanded
 * destinations, not render frames (notably, drag publishes only its final point).
 * Unchanged baseline positions are withheld: they may belong to an older action. */
export class CuaNativeCursorBridge {
  private readonly bootstrapId = `codeshell-cursor-${randomUUID()}`;
  private initializeId: unknown;
  private initialized = false;
  private bootstrapSent = false;
  private bootstrapResolve?: (state?: CursorState) => void;
  private bootstrapTimer?: ReturnType<typeof setTimeout>;
  private readyPromise?: Promise<boolean>;
  private transportSession?: string;
  private readonly lifetime = new AbortController();
  private readonly actions = new Map<string, SamplingAction>();
  private readonly confirmedPositions = new Map<string, CursorState["position"]>();
  private readonly timeoutMs: number;
  private readonly intervalMs: number;

  constructor(private readonly options: NativeCursorOptions) {
    this.timeoutMs = options.timeoutMs ?? 250;
    this.intervalMs = options.intervalMs ?? 80;
  }

  observeRequest(message: unknown): void {
    const request = object(message);
    if (request?.method === "initialize" && request.id !== undefined)
      this.initializeId = request.id;
  }

  /** Consume only our own response, including a late reply after timeout/close. */
  consumeResponse(message: unknown): boolean {
    const response = object(message);
    if (!response || !("result" in response || "error" in response)) return false;
    if (this.bootstrapSent && response.id === this.bootstrapId) {
      const result = object(response.result);
      const state =
        !response.error && result?.isError !== true
          ? cursorState(result?.structuredContent)
          : undefined;
      this.bootstrapResolve?.(state);
      return true;
    }
    if (this.initializeId !== undefined && response.id === this.initializeId) {
      const result = object(response.result);
      const server = object(result?.serverInfo);
      // The identity derivation is verified against this pinned native contract.
      this.initialized = server?.name === "cua-driver" && server.version === "0.34.1";
      this.initializeId = undefined;
    }
    return false;
  }

  async prepare(event: CuaActivityEvent, message: unknown): Promise<void> {
    if (event.capture || this.lifetime.signal.aborted || !this.initialized) return;
    const params = object(object(message)?.params);
    if (typeof params?.name !== "string" || !POSITIONED_TOOLS.has(params.name)) return;
    const args = object(params.arguments) ?? {};
    // Desktop pointer positions are a separate input lane; do not mistake its
    // real OS pointer for the independent agent-cursor registry.
    if (args.scope === "desktop" || object(args.target)?.kind === "desktop") return;
    if (!(await this.ready()) || this.lifetime.signal.aborted) return;
    const session = typeof args.session === "string" && args.session ? args.session : undefined;
    const baseline = await this.read(session, this.lifetime.signal);
    if (!baseline || this.lifetime.signal.aborted) return;
    this.actions.set(event.id, {
      event,
      session,
      previous: baseline.position,
      baselineAction: baseline.visualAction,
      expectedAction:
        params.name === "move_cursor"
          ? "navigate"
          : event.action === "type"
            ? "text"
            : event.action,
      published: false,
      controller: new AbortController(),
      running: false,
    });
  }

  /** Called only after the original request bytes have been forwarded. */
  start(id: string): void {
    const action = this.actions.get(id);
    if (!action || this.lifetime.signal.aborted) return;
    action.running = true;
    this.schedule(action);
  }

  async finish(id: string, failed: boolean): Promise<void> {
    const action = this.actions.get(id);
    if (!action) return;
    action.running = false;
    clearTimeout(action.timer);
    action.controller.abort();
    await action.task;
    if (!failed && !this.lifetime.signal.aborted) {
      // A fast click can complete between polls. One final bounded read records
      // its real destination without inventing an intermediate movement path.
      const state = await this.read(action.session, this.lifetime.signal);
      await this.publish(action, state);
    }
    this.actions.delete(id);
  }

  close(): void {
    this.lifetime.abort();
    clearTimeout(this.bootstrapTimer);
    this.bootstrapResolve?.();
    for (const action of this.actions.values()) {
      action.running = false;
      clearTimeout(action.timer);
      action.controller.abort();
    }
    this.actions.clear();
    this.confirmedPositions.clear();
  }

  private ready(): Promise<boolean> {
    this.readyPromise ??= this.bootstrap().catch(() => false);
    return this.readyPromise;
  }

  private async bootstrap(): Promise<boolean> {
    if (!this.options.childPid || this.lifetime.signal.aborted) return false;
    const state = await new Promise<CursorState | undefined>((resolve) => {
      this.bootstrapResolve = (value) => {
        clearTimeout(this.bootstrapTimer);
        this.bootstrapResolve = undefined;
        resolve(value);
      };
      this.bootstrapTimer = setTimeout(() => this.bootstrapResolve?.(), this.timeoutMs);
      this.bootstrapSent = true;
      void this.options
        .sendMcp(
          Buffer.from(
            JSON.stringify({
              jsonrpc: "2.0",
              id: this.bootstrapId,
              method: "tools/call",
              params: { name: "get_agent_cursor_state", arguments: {} },
            }) + "\n",
          ),
        )
        .catch(() => this.bootstrapResolve?.());
    });
    // Public labels are not transport identities. The default query must belong
    // to the official proxy process we spawned, never another driver's session.
    if (!state || !new RegExp(`^mcp-${this.options.childPid}-[0-9]+$`).test(state.session))
      return false;
    const peer = await readNativeCursorState(
      this.options.socketPath,
      state.session,
      undefined,
      this.lifetime.signal,
      this.timeoutMs,
    );
    if (!peer || !samePoint(peer.position, state.position)) return false;
    this.transportSession = state.session;
    return true;
  }

  private read(session: string | undefined, signal: AbortSignal): Promise<CursorState | undefined> {
    if (!this.transportSession) return Promise.resolve(undefined);
    return readNativeCursorState(
      this.options.socketPath,
      this.transportSession,
      session,
      signal,
      this.timeoutMs,
    );
  }

  private schedule(action: SamplingAction): void {
    action.timer = setTimeout(() => {
      if (!action.running || this.lifetime.signal.aborted) return;
      action.task = (async () => {
        const state = await this.read(action.session, action.controller.signal);
        if (action.running) await this.publish(action, state);
        if (action.running && !this.lifetime.signal.aborted) this.schedule(action);
      })();
    }, this.intervalMs);
  }

  private async publish(action: SamplingAction, state: CursorState | undefined): Promise<void> {
    if (this.lifetime.signal.aborted || !state?.position) return;
    const key = action.session || this.transportSession!;
    if (samePoint(action.previous, state.position)) {
      // Click -> type can legitimately keep one anchor. Accept the semantic
      // transition only at a position this bridge already confirmed; an old
      // unobserved registry point must not pull the pet to another operation.
      if (
        action.published ||
        state.visualAction !== action.expectedAction ||
        action.baselineAction === action.expectedAction ||
        !samePoint(this.confirmedPositions.get(key), state.position)
      )
        return;
    }
    action.previous = state.position;
    action.published = true;
    this.confirmedPositions.delete(key);
    this.confirmedPositions.set(key, state.position);
    while (this.confirmedPositions.size > 32)
      this.confirmedPositions.delete(this.confirmedPositions.keys().next().value!);
    try {
      await this.options.emit({
        ...action.event,
        phase: "update",
        target: state.position,
        targetSource: "native-cursor",
      });
    } catch {
      // Presentation failure never changes the real tool response.
    }
  }
}
