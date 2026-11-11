import { createHash } from "node:crypto";
import type { DesktopNotificationInput } from "../desktop-notifier.js";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type { ImGatewayOwnerChannel, ImGatewayOwnerTarget } from "../im-gateway-service.js";
import type { ImReadiness } from "./pet-notice-policy.js";
import {
  errorText,
  noticeDeliveryKey,
  parseNoticeMedia,
  type NoticeImPayload,
  type NoticeOutboxState,
  type NoticeImSendResult,
  type NoticeMediaAttachment,
  type NoticeOutlets,
  type NoticeSubmission,
  type NoticeTarget,
} from "./pet-notice-types.js";

/** Owner channel / target lookups read the gateway config from disk; a burst shares one read. */
const OWNER_LOOKUP_TTL_MS = 1_000;
/** Outbox tries for an owner notice; a target without a stored WeChat context gets one. */
export const OWNER_OUTBOX_ATTEMPTS = 5;

export interface PetNoticeWiringGateway {
  ownerChannels(): ImGatewayOwnerChannel[];
  /** Owner targets with their outbound attachment capabilities. */
  listOwnerMessageTargets(): ImGatewayOwnerTarget[];
  /** The raw destination behind an owner target id (host-only), re-checked against the allowlist. */
  resolveOwnerTarget(targetId: string): { channel: string; target: string } | undefined;
  lastOwnerInboundChannel(): string | undefined;
  /** An allowlisted owner conversation on this channel (callers also require a direct message). */
  isOwnerConversation(channel: string, target: string): boolean;
}

/** `read()`'s result for a short while (wall time), so a burst of notices reads it once. */
function shortLived<T>(read: () => T, ttlMs = OWNER_LOOKUP_TTL_MS): () => T {
  let entry: { at: number; value: T } | undefined;
  return () => {
    const at = performance.now();
    if (entry && at - entry.at < ttlMs) return entry.value;
    const value = read();
    entry = { at, value };
    return value;
  };
}

const DESKTOP_TITLES: Readonly<Record<string, string>> = {
  "session.done": "Mimi 任务已完成",
  "session.failed": "Mimi 任务执行失败",
  "session.blocked": "Mimi：需要你决定",
  "decision.expired": "Mimi 任务确认",
  "session.report": "Mimi 工作更新",
  "followup.due": "Mimi 跟进提醒",
  digest: "Mimi：你不在时",
};

/**
 * Pending decisions already have one desktop surface: the pet's attention
 * peek / pending count. Their routed notices (the code-bearing prompt and its
 * expiry) therefore never add a native notification on top.
 */
function hasDesktopSurface(notice: NoticeSubmission): boolean {
  return (
    (notice.kind === "session.blocked" && notice.requestId !== undefined) ||
    notice.kind === "decision.expired"
  );
}

const ROUTE_EVENT_TYPES: Readonly<Record<string, GatewayControlEventInput["type"]>> = {
  "session.done": "pet.task.completed",
  "session.failed": "pet.task.failed",
};

/** Attachments this owner target accepts, in order, within its count and size limits. */
function attachmentsFor(
  target: ImGatewayOwnerTarget | undefined,
  attachments: readonly NoticeMediaAttachment[] | undefined,
): NoticeMediaAttachment[] {
  if (!target || !attachments) return [];
  return attachments
    .filter(
      (attachment) =>
        target.attachments.includes(attachment.kind) &&
        attachment.size <= target.maxAttachmentBytes,
    )
    .slice(0, target.maxAttachments);
}

/** The durable gateway outbox, as the notices use it (main's GatewayControlServer). */
export interface PetNoticeOutbox {
  /** `publishGatewayControlEvent`: idempotent by deliveryKey; accepted = enqueued. */
  publish(event: GatewayControlEventInput): Promise<void>;
  /** Withdraw a delivery not yet made; it is never sent after this resolves. */
  revoke(deliveryKey: string): Promise<void>;
  state(deliveryKey: string): NoticeOutboxState | undefined;
}

export interface PetNoticeOutletDeps {
  gateway: PetNoticeWiringGateway;
  outbox: PetNoticeOutbox;
  /** Native desktop notification (`DesktopNotifier.notify`); click opens `sessionId`. */
  notifyDesktop(input: DesktopNotificationInput): Promise<unknown>;
  log: (event: string, data: Record<string, unknown>) => void;
}

/** Where the router's notices leave the process, and the owner lookups they depend on. */
export interface PetNoticeOutletSet extends NoticeOutlets {
  /** Bound owner channels, read at most once a second. */
  ownerChannels(): ImGatewayOwnerChannel[];
  /** Each owner channel's readiness, as the routing policy reads it. */
  imChannels(): Record<string, ImReadiness>;
}

export function createNoticeOutlets(deps: PetNoticeOutletDeps): PetNoticeOutletSet {
  const { log } = deps;
  const ownerChannels = shortLived(() => deps.gateway.ownerChannels());
  const ownerTargets = shortLived(() => deps.gateway.listOwnerMessageTargets());

  const desktop = (notice: NoticeSubmission, body: string): void => {
    if (hasDesktopSurface(notice)) return;
    const key = createHash("sha256")
      .update("pet-notice\0")
      .update(notice.dedupeKey)
      .update("\0")
      .update(body)
      .digest("hex");
    const files = notice.media?.attachments?.length ?? 0;
    void Promise.resolve(
      deps.notifyDesktop({
        key,
        title: DESKTOP_TITLES[notice.kind] ?? "Mimi",
        // Clicking opens the Session, where the files are.
        body: files > 0 ? `${body}\n（含 ${files} 个附件，打开会话查看）` : body,
        ...(notice.priority === "P0" ? { urgent: true } : {}),
        ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
      }),
    ).catch((error) =>
      log("pet.notice.desktop_notify_failed", { kind: notice.kind, error: errorText(error) }),
    );
  };

  /**
   * Every IM notice is written to the durable gateway outbox (accepted =
   * enqueued), which delivers and retries it and reports the result. The
   * deliveryKey derives from the record's claim key, so a resend of the same
   * record is the same delivery. A route notice goes back to its conversation;
   * an owner notice to the channel's owner target (resolved here, authorized
   * again by the relay), with only the attachments that target accepts and a
   * retry budget: one try when no WeChat context is stored, as an interactive
   * owner send gets.
   */
  async function im(
    channel: string,
    target: NoticeTarget,
    body: string,
    key: string | undefined,
    payload: NoticeImPayload,
  ): Promise<NoticeImSendResult> {
    const media = parseNoticeMedia(payload.media);
    try {
      let destination: { channel: string; target: string };
      let files = media?.attachments ?? [];
      let maxAttempts: number | undefined;
      if (target.kind === "route") {
        destination = { channel: target.route.channel, target: target.route.target };
      } else {
        const targetId = ownerChannels().find((entry) => entry.id === channel)?.targetId;
        if (!targetId) return { accepted: false, error: "no-owner-target" };
        const ownerTarget = ownerTargets().find((entry) => entry.id === targetId);
        const resolved = deps.gateway.resolveOwnerTarget(targetId);
        if (!resolved) return { accepted: false, error: "no-owner-target" };
        destination = resolved;
        // A group (or unconfirmed) owner target never gets private decision details.
        if (ownerTarget?.isDirect !== true && payload.nonDirectBody) body = payload.nonDirectBody;
        files = attachmentsFor(ownerTarget, media?.attachments);
        maxAttempts = ownerTarget?.proactiveReady === "ready" ? OWNER_OUTBOX_ATTEMPTS : 1;
      }
      const title = DESKTOP_TITLES[payload.kind];
      await deps.outbox.publish({
        deliveryKey: noticeDeliveryKey(
          key ?? createHash("sha256").update(body).digest("hex").slice(0, 24),
          target,
        ),
        type: ROUTE_EVENT_TYPES[payload.kind] ?? "pet.task.reported",
        ...(title ? { title } : {}),
        text: body,
        ...(media?.button ? { button: media.button } : {}),
        ...(files.length > 0
          ? { attachments: files.map(({ sha256: _digest, ...file }) => file) }
          : {}),
        target: destination,
        ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      });
      return { accepted: true, enqueued: true };
    } catch (error) {
      return { accepted: false, error: errorText(error) };
    }
  }

  return {
    ownerChannels,
    revoke: (deliveryKey) => deps.outbox.revoke(deliveryKey),
    outboxState: (deliveryKey) => deps.outbox.state(deliveryKey),
    imChannels() {
      const result: Record<string, ImReadiness> = {};
      for (const entry of ownerChannels()) result[entry.id] = entry.ready;
      return result;
    },
    desktop,
    im,
  };
}
