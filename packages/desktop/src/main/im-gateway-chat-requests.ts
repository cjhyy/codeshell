import { createHash, randomUUID } from "node:crypto";
import type { PetChatControlRequest, PetChatControlResult } from "./im-gateway-control-server.js";

export class GatewayChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 503,
  ) {
    super(message);
  }
}

interface Ticket {
  id: string;
  key?: string;
  fingerprint: string;
  waiters: Set<() => void>;
  settledAt?: number;
  outcome?: { result: PetChatControlResult } | { error: unknown };
}

/** In-process correlation only. Durable recovery belongs to the inbox, worker
 * clientMessageId replay and host action receipts; no model work lives in HTTP. */
export class GatewayChatRequests {
  private readonly tickets = new Map<string, Ticket>();
  private readonly identities = new Map<string, string>();

  constructor(
    private readonly run: (request: PetChatControlRequest) => Promise<PetChatControlResult>,
    private readonly limits = { capacity: 256, retentionMs: 10 * 60_000 },
    private readonly now: () => number = Date.now,
  ) {}

  start(request: PetChatControlRequest): { requestId: string; pending: true } {
    this.prune();
    const origin = request.origin;
    const key = origin?.messageId
      ? JSON.stringify([origin.channel, origin.target, origin.senderId, origin.messageId])
      : undefined;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([request.message, request.attachments ?? []]))
      .digest("hex");
    const existing = key ? this.tickets.get(this.identities.get(key) ?? "") : undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new GatewayChatRequestError("同一消息的内容发生变化，未重复执行", 409);
      }
      return { requestId: existing.id, pending: true };
    }
    if (this.tickets.size >= this.limits.capacity) {
      // Only terminal tickets may be evicted; running work must keep its owner.
      const oldest = [...this.tickets.values()].find((ticket) => ticket.outcome);
      if (oldest) this.remove(oldest);
      else throw new GatewayChatRequestError("Mimi 正在处理较多消息，请稍后重试", 503);
    }
    const ticket: Ticket = { id: randomUUID(), key, fingerprint, waiters: new Set() };
    this.tickets.set(ticket.id, ticket);
    if (key) this.identities.set(key, ticket.id);
    void Promise.resolve()
      .then(() => this.run(request))
      .then(
        (result) => {
          ticket.outcome = { result };
        },
        (error) => {
          ticket.outcome = { error };
        },
      )
      .then(() => {
        ticket.settledAt = this.now();
        for (const notify of ticket.waiters) notify();
      });
    return { requestId: ticket.id, pending: true };
  }

  async poll(
    requestId: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<PetChatControlResult | { requestId: string; pending: true }> {
    this.prune();
    const ticket = this.tickets.get(requestId);
    if (!ticket) {
      // A host restart/expired cache is recoverable through the durable inbox.
      throw new GatewayChatRequestError("Mimi 请求记录已过期，请使用原消息身份重试", 503);
    }
    if (!ticket.outcome && waitMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          ticket.waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(waitMs, 25_000));
        timer.unref?.();
        signal?.addEventListener("abort", finish, { once: true });
        ticket.waiters.add(finish);
      });
    }
    if (!ticket.outcome) return { requestId, pending: true };
    if ("error" in ticket.outcome) throw ticket.outcome.error;
    return ticket.outcome.result;
  }

  clear(): void {
    for (const ticket of this.tickets.values()) {
      for (const notify of ticket.waiters) notify();
    }
    this.tickets.clear();
    this.identities.clear();
  }

  private prune(): void {
    for (const ticket of this.tickets.values()) {
      if (
        ticket.settledAt !== undefined &&
        this.now() - ticket.settledAt >= this.limits.retentionMs
      ) {
        this.remove(ticket);
      }
    }
  }

  private remove(ticket: Ticket): void {
    this.tickets.delete(ticket.id);
    if (ticket.key) this.identities.delete(ticket.key);
  }
}
