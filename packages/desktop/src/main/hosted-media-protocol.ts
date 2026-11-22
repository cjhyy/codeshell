import { randomUUID } from "node:crypto";
import { parseMediaPreviewRequest, type MediaPreviewResult } from "../shared/media-preview.js";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";

type Lease = {
  ownerId: number;
  sessionId: string;
  controller: AbortController;
  signal: AbortSignal;
};

/** Chromium owns the protocol handler. File descriptors, ranges, workspace
 * resolution and byte reads live in the utility. Recheck native ownership
 * before handing each asynchronous result to the requesting document. */
export class NativeMediaProtocol {
  private readonly owners = new Set<number>();
  private readonly pending = new Set<Lease>();
  private readonly grants = new Map<string, Lease>();
  constructor(
    private readonly call: CallShellBusiness,
    private readonly mayUse: (ownerId: number, sessionId: string) => boolean,
  ) {}

  private current(lease: Lease) {
    return !lease.signal.aborted && this.mayUse(lease.ownerId, lease.sessionId);
  }

  async create(
    ownerId: number,
    input: unknown,
    document: AbortSignal,
  ): Promise<MediaPreviewResult | null> {
    const request = parseMediaPreviewRequest(input);
    if (!request || document.aborted || !this.mayUse(ownerId, request.sessionId)) return null;
    const controller = new AbortController();
    const lease = {
      ownerId,
      sessionId: request.sessionId,
      controller,
      signal: AbortSignal.any([controller.signal, document]),
    };
    this.pending.add(lease);
    this.owners.add(ownerId);
    try {
      const preview = await this.call("media/create", { ownerId, request }, lease.signal);
      if (!preview) return null;
      if (!this.current(lease)) {
        void this.call("media/release", { ownerId, url: preview.url }).catch(() => {});
        return null;
      }
      this.grants.set(preview.url, lease);
      return preview;
    } catch {
      return null;
    } finally {
      this.pending.delete(lease);
    }
  }

  release(ownerId: number, url: string) {
    const lease = this.grants.get(url);
    if (lease?.ownerId !== ownerId) return;
    lease.controller.abort();
    this.grants.delete(url);
    void this.call("media/release", { ownerId, url }).catch(() => {});
  }

  private revoke(filter: (lease: Lease) => boolean) {
    let revoked = false;
    for (const lease of this.pending) {
      if (!filter(lease)) continue;
      revoked = true;
      lease.controller.abort();
    }
    for (const [url, lease] of this.grants) {
      if (!filter(lease)) continue;
      lease.controller.abort();
      this.grants.delete(url);
      revoked = true;
    }
    return revoked;
  }

  releaseOwner(id: number) {
    if (!this.owners.delete(id)) return;
    this.revoke((lease) => lease.ownerId === id);
    void this.call("media/releaseOwner", id).catch(() => {});
  }
  releaseSession(id: string) {
    if (!this.revoke((lease) => lease.sessionId === id)) return;
    void this.call("media/releaseSession", id).catch(() => {});
  }

  async respond(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    const lease = this.grants.get(request.url);
    if (!lease) return new Response(null, { status: 404 });
    const owned = () => {
      if (this.current(lease)) return true;
      this.release(lease.ownerId, request.url);
      return false;
    };
    if (!owned()) return new Response(null, { status: 404 });
    const signal = AbortSignal.any([request.signal, lease.signal]);
    const stream = randomUUID();
    const cancel = () => {
      void this.call("media/cancel", stream).catch(() => {});
    };
    try {
      const { status, headers, body } = await this.call(
        "media/open",
        {
          stream,
          url: request.url,
          method: request.method,
          range: request.headers.get("range"),
        },
        signal,
      );
      if (!owned() || signal.aborted) {
        if (body) cancel();
        return new Response(null, { status: 404 });
      }
      if (!body) {
        if (status === 404) this.release(lease.ownerId, request.url);
        return new Response(null, { status, headers });
      }
      let closed = false;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stop = () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", abort);
        cancel();
      };
      const abort = () => {
        if (closed) return;
        controller.error(new DOMException("Media read aborted", "AbortError"));
        stop();
      };
      const output = new ReadableStream<Uint8Array>(
        {
          start(sink) {
            controller = sink;
            signal.addEventListener("abort", abort, { once: true });
          },
          pull: async (sink) => {
            if (closed) return;
            try {
              if (!owned()) throw Error("Media owner closed");
              const bytes = await this.call("media/pull", stream, signal);
              if (closed) return;
              if (!owned()) throw Error("Media owner closed");
              if (bytes === null) {
                signal.removeEventListener("abort", abort);
                closed = true;
                sink.close();
              } else sink.enqueue(bytes);
            } catch (error) {
              if (closed) return;
              sink.error(error);
              stop();
            }
          },
          cancel: stop,
        },
        { highWaterMark: 0 },
      );
      return new Response(output, { status, headers });
    } catch {
      cancel();
      return new Response(null, { status: 404 });
    }
  }
}
