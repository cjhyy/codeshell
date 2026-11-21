/** One private duplex port. Request ids, cancellation and outstanding replies expire with the port. */
export interface PrivatePort {
  send(message: unknown): void;
  listen(receive: (message: unknown) => void, closed: () => void): void;
  close(): void;
}
interface Request {
  type: "call";
  id: number;
  method: string;
  input: unknown;
}
type Message =
  | Request
  | { type: "abort"; id: number }
  | { type: "reply"; id: number; value?: unknown; error?: string };
export class PrivateHostPeer {
  private seq = 0;
  private closed = false;
  private readonly active = new Map<number, AbortController>();
  private readonly waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(
    private readonly port: PrivatePort,
    private readonly handle: (method: string, input: unknown, signal: AbortSignal) => unknown,
    private readonly onClose?: () => void,
  ) {
    port.listen(
      (message) => {
        void this.receive(message as Message);
      },
      () => this.close(),
    );
  }
  call<R>(method: string, input: unknown, signal?: AbortSignal): Promise<R> {
    signal?.throwIfAborted();
    if (this.closed || this.waiting.size >= 512)
      return Promise.reject(Error("Private Host service unavailable"));
    const id = ++this.seq;
    const abort = () => this.send({ type: "abort", id });
    const result = new Promise<R>((resolve, reject) => {
      this.waiting.set(id, { resolve: (value) => resolve(value as R), reject });
      signal?.addEventListener("abort", abort, { once: true });
      this.send({ type: "call", id, method, input });
    });
    return result.finally(() => signal?.removeEventListener("abort", abort));
  }
  private async receive(msg: Message) {
    if (this.closed || !msg || !Number.isSafeInteger(msg.id)) return;
    if (msg.type === "reply") {
      const entry = this.waiting.get(msg.id);
      if (!entry) return;
      this.waiting.delete(msg.id);
      if (msg.error !== undefined) entry.reject(new Error(msg.error));
      else entry.resolve(msg.value);
    } else if (msg.type === "abort") this.active.get(msg.id)?.abort();
    else if (msg.type === "call") {
      if (this.active.has(msg.id) || this.active.size >= 512) {
        this.send({ type: "reply", id: msg.id, error: "Too many pending Host operations" });
        return;
      }
      const controller = new AbortController();
      this.active.set(msg.id, controller);
      try {
        const value = await this.handle(msg.method, msg.input, controller.signal);
        this.send({ type: "reply", id: msg.id, value });
      } catch (error) {
        this.send({
          type: "reply",
          id: msg.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.active.delete(msg.id);
      }
    }
  }
  private send(message: Message) {
    if (this.closed) return;
    try {
      this.port.send(message);
    } catch {
      this.close();
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.waiting.values())
      entry.reject(Error("Private Host service disconnected"));
    this.waiting.clear();
    for (const c of this.active.values()) c.abort();
    this.active.clear();
    this.port.close();
    this.onClose?.();
  }
}
export function nodePrivatePort(port: import("node:worker_threads").MessagePort): PrivatePort {
  return {
    send: (v) => port.postMessage(v),
    listen: (fn, close) => {
      port.on("message", fn);
      port.once("close", close);
    },
    close: () => port.close(),
  };
}
export function electronPrivatePort(
  port: Pick<Electron.MessagePortMain, "postMessage" | "on" | "start" | "close">,
): PrivatePort {
  return {
    send: (v) => port.postMessage(v),
    listen: (fn, close) => {
      port.on("message", ({ data, ports }) => {
        for (const extra of ports) extra.close();
        if (!ports.length) fn(data);
      });
      port.on("close", close);
      port.start();
    },
    close: () => port.close(),
  };
}
