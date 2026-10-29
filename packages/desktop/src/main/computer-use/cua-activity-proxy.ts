/** MCP stdio gate and observer for the embedded driver.
 *
 * Execution: every tools/call is checked against the host-owned input gate at
 * dispatch time. A refused call never reaches the driver; the caller receives a
 * local MCP error. Accepted bytes are forwarded unchanged, except that this
 * proxy removes its own Session-lineage `_meta` key.
 *
 * Presentation: activity events are emitted after forwarding and never delay
 * input. The one exception is a screen capture, which waits (bounded) for the
 * host to hide the character so it cannot appear in the model's screenshot.
 *
 * Build as a separate Node entry; it owns only the MCP client, never the daemon. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { describedApp, loadAppProfiles, withAppNotes } from "./app-profiles.js";
import { CuaActivityTracker, type CuaActivityEvent } from "./cua-activity.js";
import { CuaNativeCursorBridge } from "./cua-native-cursor.js";
import {
  gateDecision,
  gateFullyOpen,
  INPUT_POLICY_NOTES,
  isWithheldTool,
  parseInputGateState,
  parseSessionLineage,
  REFUSAL_POLICY_NOTE,
  refusalResponse,
  SESSION_META_KEY,
  type InputGateState,
} from "./input-gate-policy.js";

const ACK_TIMEOUT_MS = 180;
const GATE_WAIT_MS = 1_000;
const RECONNECT_MS = 250;
const MAX_ACTIVITY_BYTES = 2_048;
const MAX_HOST_LINE_BYTES = 64 * 1024;
const MAX_INSPECT_BYTES = 16 * 1024 * 1024;
const MAX_ACKS = 256;

/** Private, authenticated link to Desktop main: activity out, gate state in. */
export class CuaActivityChannel {
  private socket?: Socket;
  private connecting?: Promise<Socket | undefined>;
  private closed = false;
  private buffer = "";
  private gateState?: InputGateState;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly gateWaiters = new Set<() => void>();
  private readonly acknowledgements = new Map<string, (ok: boolean) => void>();

  constructor(
    private readonly path: string | undefined,
    private readonly token: string | undefined,
    private readonly timeoutMs = ACK_TIMEOUT_MS,
  ) {}

  /** The current host gate, or undefined while the host is unreachable. */
  gate(): InputGateState | undefined {
    return this.socket && !this.socket.destroyed ? this.gateState : undefined;
  }

  /** Bounded wait for the host's first gate push after (re)connecting. */
  async waitForGate(timeoutMs = GATE_WAIT_MS): Promise<InputGateState | undefined> {
    const current = this.gate();
    if (current || this.closed || !this.usable()) return current;
    const deadline = Date.now() + timeoutMs;
    await this.connect();
    const remaining = deadline - Date.now();
    if (!this.gate() && remaining > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.gateWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        this.gateWaiters.add(done);
      });
    }
    return this.gate();
  }

  /** Fire-and-forget presentation event. Never awaited on the input path. */
  async post(event: CuaActivityEvent): Promise<void> {
    const line = this.line(event);
    if (!line) return;
    const socket = await this.connect();
    if (socket && !socket.destroyed) socket.write(line);
  }

  /** Event that needs the host's acknowledgement (screen-capture hiding). */
  async send(event: CuaActivityEvent): Promise<boolean> {
    const line = this.line(event);
    if (!line || this.acknowledgements.size >= MAX_ACKS) return false;
    const deadline = Date.now() + Math.min(ACK_TIMEOUT_MS, Math.max(1, this.timeoutMs));
    const socket = await this.connect();
    if (!socket || socket.destroyed || Date.now() >= deadline) return false;
    return new Promise<boolean>((resolve) => {
      const key = `${event.id}:${event.phase}`;
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.acknowledgements.delete(key);
        resolve(ok);
      };
      // A late ACK only costs presentation. The connection also carries the
      // input gate, so it is kept rather than destroyed on timeout.
      const timer = setTimeout(() => finish(false), Math.max(1, deadline - Date.now()));
      this.acknowledgements.set(key, finish);
      socket.write(line, (error) => {
        if (error) finish(false);
      });
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.gateState = undefined;
    for (const finish of this.acknowledgements.values()) finish(false);
    this.acknowledgements.clear();
    for (const wake of this.gateWaiters) wake();
  }

  private usable(): boolean {
    return !!this.path && !!this.token && this.token.length <= 512;
  }

  private line(event: CuaActivityEvent): string | undefined {
    if (this.closed || !this.usable()) return;
    const line = `${JSON.stringify({ token: this.token, ...event })}\n`;
    return Buffer.byteLength(line) > MAX_ACTIVITY_BYTES ? undefined : line;
  }

  connect(): Promise<Socket | undefined> {
    if (this.closed || !this.usable()) return Promise.resolve(undefined);
    if (this.socket && !this.socket.destroyed && !this.socket.connecting)
      return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const pending = new Promise<Socket | undefined>((resolve) => {
      const socket = createConnection(this.path!);
      this.socket = socket;
      this.buffer = "";
      this.gateState = undefined;
      let settled = false;
      const finish = (value?: Socket): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(
        () => {
          finish();
          socket.destroy();
        },
        Math.min(ACK_TIMEOUT_MS, Math.max(1, this.timeoutMs)),
      );
      socket.once("connect", () => {
        // Authenticate first; the host answers with the current gate state.
        socket.write(`${JSON.stringify({ token: this.token, type: "hello" })}\n`);
        finish(socket);
      });
      socket.on("error", () => {
        finish();
        socket.destroy();
      });
      socket.on("close", () => {
        finish();
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.buffer = "";
        this.gateState = undefined;
        for (const acknowledge of this.acknowledgements.values()) acknowledge(false);
        this.acknowledgements.clear();
        // Keep the gate current without waiting for the next input call.
        if (!this.closed) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => void this.connect(), RECONNECT_MS);
          this.reconnectTimer.unref?.();
        }
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > MAX_HOST_LINE_BYTES * 2) {
          socket.destroy();
          return;
        }
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > MAX_HOST_LINE_BYTES) {
            socket.destroy();
            return;
          }
          try {
            const message = JSON.parse(line);
            if (message?.type === "gate") {
              const next = parseInputGateState(message.gate);
              if (!next) {
                socket.destroy();
                return;
              }
              if (!this.gateState || next.version >= this.gateState.version) this.gateState = next;
              for (const wake of [...this.gateWaiters]) wake();
            } else if (
              typeof message?.id === "string" &&
              (message.phase === "start" || message.phase === "update" || message.phase === "end")
            ) {
              this.acknowledgements.get(`${message.id}:${message.phase}`)?.(message.ok === true);
            }
          } catch {
            socket.destroy();
            return;
          }
        }
      });
    });
    this.connecting = pending.finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
}

interface WirePart {
  bytes: Buffer;
  inspect: boolean;
  overflow: boolean;
}

/** Bound inspection memory while preserving arbitrary protocol bytes, including
 * split UTF-8 sequences and messages larger than the observer understands. */
export async function* cuaWireParts(
  source: Readable,
  limit = MAX_INSPECT_BYTES,
): AsyncGenerator<WirePart> {
  let chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf(10, from);
      const end = newline >= 0 ? newline + 1 : chunk.length;
      const part = chunk.subarray(from, end);
      if (overflow) {
        yield { bytes: part, inspect: false, overflow: false };
      } else if (size + part.length > limit) {
        yield { bytes: Buffer.concat([...chunks, part]), inspect: false, overflow: true };
        chunks = [];
        size = 0;
        overflow = true;
      } else {
        chunks.push(part);
        size += part.length;
        if (newline >= 0) {
          yield { bytes: Buffer.concat(chunks, size), inspect: true, overflow: false };
          chunks = [];
          size = 0;
        }
      }
      if (newline >= 0) overflow = false;
      from = end;
    }
  }
  if (size) yield { bytes: Buffer.concat(chunks, size), inspect: true, overflow: false };
}

function parsed(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

function write(destination: Writable, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) =>
    destination.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
}

export function parseCuaActivityProxyArgs(args: readonly string[]): {
  driver: string;
  socket: string;
} {
  if (
    args.length !== 4 ||
    args[0] !== "--driver" ||
    args[2] !== "--socket" ||
    !args[1] ||
    !args[3]
  ) {
    throw new Error("Expected --driver <executable> --socket <private socket>");
  }
  return { driver: args[1], socket: args[3] };
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function requestId(value: unknown): string | number | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

interface ToolCall {
  id: string | number;
  name: string;
  args: JsonRecord;
  sessionIds: string[];
  /** Original message without this proxy's private `_meta` key, when present. */
  stripped?: JsonRecord;
}

/** Recognise a JSON-RPC tools/call and peel off the caller's Session lineage. */
export function toolCall(message: unknown): ToolCall | undefined {
  const request = record(message);
  const params = record(request?.params);
  const id = requestId(request?.id);
  if (request?.method !== "tools/call" || id === undefined || typeof params?.name !== "string")
    return;
  const meta = record(params._meta);
  const sessionIds = parseSessionLineage(meta?.[SESSION_META_KEY]);
  let stripped: JsonRecord | undefined;
  if (meta && SESSION_META_KEY in meta) {
    const { [SESSION_META_KEY]: _lineage, ...restMeta } = meta;
    const { _meta: _old, ...restParams } = params;
    stripped = {
      ...request,
      params: Object.keys(restMeta).length ? { ...restParams, _meta: restMeta } : restParams,
    };
  }
  return { id, name: params.name, args: record(params.arguments) ?? {}, sessionIds, stripped };
}

/** Drop withheld tools and append the CodeShell input strategy to the
 * model-facing tool descriptions. */
export function annotateToolList(message: unknown): JsonRecord | undefined {
  const response = record(message);
  const result = record(response?.result);
  if (!response || !result || !Array.isArray(result.tools)) return;
  const offered = result.tools.filter((tool) => {
    const name = record(tool)?.name;
    return typeof name !== "string" || !isWithheldTool(name);
  });
  let changed = offered.length !== result.tools.length;
  const tools = offered.map((tool) => {
    const item = record(tool);
    if (!item || typeof item.name !== "string") return tool;
    const note = INPUT_POLICY_NOTES[item.name];
    const base = typeof item.description === "string" ? item.description : item.name;
    if (base.includes(REFUSAL_POLICY_NOTE)) return tool;
    changed = true;
    return {
      ...item,
      description: [base, note, REFUSAL_POLICY_NOTE].filter(Boolean).join("\n\n"),
    };
  });
  return changed ? { ...response, result: { ...result, tools } } : undefined;
}

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

export async function runCuaActivityProxy(args = process.argv.slice(2)): Promise<number> {
  const { driver, socket } = parseCuaActivityProxyArgs(args);
  const tracker = new CuaActivityTracker(randomUUID());
  const channel = new CuaActivityChannel(
    process.env.CODE_SHELL_CUA_ACTIVITY_SOCKET,
    process.env.CODE_SHELL_CUA_ACTIVITY_TOKEN,
  );
  void channel.connect();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, CUA_DRIVER_EMBEDDED: "1" };
  delete childEnv.CODE_SHELL_CUA_ACTIVITY_SOCKET;
  delete childEnv.CODE_SHELL_CUA_ACTIVITY_TOKEN;
  delete childEnv.CODE_SHELL_CUA_APP_PROFILES;
  const profiles = loadAppProfiles(process.env.CODE_SHELL_CUA_APP_PROFILES, (file, reason) =>
    process.stderr.write(`CUA app profile ${file} skipped: ${reason}\n`),
  );
  // App notes reach the model once per Session root and app, on the result of
  // the call that first describes that app. Bounded; content-free keys only.
  const noteRequests = new Map<string | number, string>();
  const appByPid = new Map<number, string>();
  const noted = new Set<string>();
  const remember = <K, V>(map: Map<K, V> | Set<K>, limit: number) => {
    while (map.size > limit) map.delete(map.keys().next().value!);
  };
  const child = spawn(driver, ["mcp", "--embedded", "--socket", socket], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // One ordered presentation lane. Nothing on the input path awaits it.
  let emitting = Promise.resolve();
  const enqueue = (work: () => Promise<unknown> | unknown): void => {
    emitting = emitting.then(work).then(
      () => {},
      () => {},
    );
  };
  const cursor = new CuaNativeCursorBridge({
    socketPath: socket,
    childPid: child.pid,
    sendMcp: (bytes) => write(child.stdin, bytes),
    emit: async (event) => enqueue(() => channel.post(event)),
    emitFinal: (event) => channel.post(event),
  });
  const delivered = new Set<string>();
  const toolLists = new Set<string | number>();
  let observing = true;
  let turnId: unknown;
  let turnDone = Promise.resolve();
  let completeTurn: (() => void) | undefined;
  const releaseTurn = (): void => {
    completeTurn?.();
    completeTurn = undefined;
    turnId = undefined;
  };
  // Presentation only. The input gate and the channel that carries it stay on.
  const disableObserver = (): void => {
    observing = false;
    tracker.clear();
    delivered.clear();
    cursor.close();
  };
  const stop = (): void => {
    disableObserver();
    releaseTurn();
    channel.close();
    child.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  child.stderr.pipe(process.stderr, { end: false });
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
  const incoming = (async () => {
    let discarding = false;
    for await (const part of cuaWireParts(process.stdin)) {
      // The pinned child dispatches requests serially. Waiting here does not
      // delay real work, and it makes the gate check happen at dispatch time.
      await turnDone;
      const endsLine = part.bytes[part.bytes.length - 1] === 10;
      if (!part.inspect) {
        // Too large to classify. Forward only when no hold of any kind applies.
        if (part.overflow) {
          disableObserver();
          discarding = !gateFullyOpen(channel.gate());
          if (discarding) process.stderr.write("CUA proxy refused an uninspectable request.\n");
        }
        if (!discarding) await write(child.stdin, part.bytes);
        if (endsLine) discarding = false;
        continue;
      }
      const message = parsed(part.bytes);
      const call = toolCall(message);
      let bytes = part.bytes;
      if (call) {
        const decision = gateDecision(channel.gate() ?? (await gateFor(call)), call);
        if (!decision.allow) {
          await write(process.stdout, line(refusalResponse(call.id, decision)));
          continue;
        }
        if (call.stripped) bytes = line(call.stripped);
        if (
          profiles.profiles.length &&
          (call.name === "get_window_state" || call.name === "launch_app")
        ) {
          noteRequests.set(call.id, call.sessionIds[call.sessionIds.length - 1] ?? "");
          remember(noteRequests, 256);
        }
      }
      const request = record(message);
      if (request?.method === "tools/list" && requestId(request.id) !== undefined)
        toolLists.add(requestId(request.id)!);
      let event: CuaActivityEvent | undefined;
      if (observing) {
        cursor.observeRequest(message);
        event = tracker.begin(message);
        const appId = event?.pid !== undefined ? appByPid.get(event.pid) : undefined;
        if (event && appId) event.appId = appId;
        // Screen capture is the only synchronous step: the character must be
        // hidden before the driver captures pixels for the model.
        if (event?.capture) {
          await channel.send(event);
          delivered.add(event.id);
        }
      }
      if (
        request?.jsonrpc === "2.0" &&
        typeof request.method === "string" &&
        requestId(request.id) !== undefined
      ) {
        turnId = request.id;
        turnDone = new Promise((resolve) => {
          completeTurn = resolve;
        });
      }
      await write(child.stdin, bytes);
      if (observing) {
        if (event && !event.capture) {
          const started = event;
          delivered.add(started.id);
          enqueue(() => channel.post(started));
          cursor.track(started, message);
        }
        void cursor.observeForwarded(message);
      }
    }
    child.stdin.end();
  })();
  async function gateFor(call: ToolCall): Promise<InputGateState | undefined> {
    // Read-only and withheld calls never wait; input waits (bounded) for the first push.
    const decision = gateDecision(undefined, call);
    return decision.allow || decision.reason === "tool-withheld"
      ? undefined
      : channel.waitForGate();
  }
  const outgoing = (async () => {
    for await (const part of cuaWireParts(child.stdout)) {
      if (part.overflow) disableObserver();
      const message = part.inspect ? parsed(part.bytes) : undefined;
      // Always consume our late private reply, even after observation is disabled.
      if (part.inspect && cursor.consumeResponse(message)) continue;
      const response = record(message);
      const id = requestId(response?.id);
      let bytes = part.bytes;
      if (id !== undefined && toolLists.delete(id)) {
        const annotated = annotateToolList(message);
        if (annotated) bytes = line(annotated);
      }
      const root = id !== undefined ? noteRequests.get(id) : undefined;
      if (id !== undefined && root !== undefined && response) {
        noteRequests.delete(id);
        const app = describedApp(response.result);
        const profile = app && profiles.match(app);
        if (profile && app.pid !== undefined) {
          appByPid.set(app.pid, profile.id);
          remember(appByPid, 128);
        }
        const key = `${root}\u0000${profile?.id}`;
        const noteful = profile && !noted.has(key) ? withAppNotes(response, profile) : undefined;
        if (noteful) {
          noted.add(key);
          remember(noted, 512);
          bytes = line(noteful);
        }
      }
      await write(process.stdout, bytes);
      if (response && ("result" in response || "error" in response) && response.id === turnId)
        releaseTurn();
      else if (completeTurn && response && ("result" in response || "error" in response)) {
        // A malformed request may receive a null-ID protocol error. Do not hold
        // later original bytes indefinitely for the advisory observer.
        disableObserver();
        releaseTurn();
      }
      if (observing && part.inspect) {
        const event = tracker.finish(message);
        if (event && delivered.delete(event.id)) {
          const finished = event;
          enqueue(async () => {
            // The final cursor read and the end stay ahead of the next start.
            await cursor.finish(finished.id, finished.failed === true);
            await channel.post(finished);
          });
        }
      }
    }
  })();
  // A broken pipe must not leave a proxy client and capture activity alive.
  void incoming.catch(stop);
  void outgoing.catch(stop);
  const exitCode = await exited;
  cursor.close();
  releaseTurn();
  process.stdin.destroy();
  await Promise.allSettled([incoming, outgoing]);
  await Promise.race([emitting, new Promise((resolve) => setTimeout(resolve, 250))]);
  disableObserver();
  channel.close();
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  return exitCode;
}

// Works for the source Bun entry and the packaged CJS bundle without relying
// on import.meta in a CommonJS build. Importing it from tests has no effects.
if (/(?:^|[/\\])cua-activity-proxy\.(?:[cm]?js|ts)$/.test(process.argv[1] ?? "")) {
  void runCuaActivityProxy().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("CUA activity proxy failed to start.\n");
      process.exitCode = 1;
    },
  );
}
