import { createHash } from "node:crypto";
import type { OutgoingAttachment } from "@cjhyy/code-shell-chat";
import type { DesktopNotificationInput } from "../desktop-notifier.js";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type {
  ImGatewayOwnerChannel,
  ImGatewayOwnerSendOptions,
  ImGatewayOwnerTarget,
} from "../im-gateway-service.js";
import type { ImReadiness } from "./pet-notice-policy.js";
import {
  errorText,
  parseNoticeMedia,
  type NoticeImPayload,
  type NoticeImSendResult,
  type NoticeMediaAttachment,
  type NoticeOutlets,
  type NoticeSubmission,
  type NoticeTarget,
} from "./pet-notice-types.js";

/** Owner channel / target lookups read the gateway config from disk; a burst shares one read. */
const OWNER_LOOKUP_TTL_MS = 1_000;

export interface PetNoticeWiringGateway {
  ownerChannels(): ImGatewayOwnerChannel[];
  /** Owner targets with their outbound attachment capabilities. */
  listOwnerMessageTargets(): ImGatewayOwnerTarget[];
  sendOwnerMessage(
    targetId: string,
    text: string,
    attachments: readonly OutgoingAttachment[],
    options?: ImGatewayOwnerSendOptions,
  ): Promise<unknown>;
  supportsIdempotentOwnerSend(channel: string): boolean;
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

export const DESKTOP_TITLES: Readonly<Record<string, string>> = {
  "session.done": "Mimi 任务已完成",
  "session.failed": "Mimi 任务执行失败",
  "session.blocked": "Mimi：需要你决定",
  "decision.expired": "Mimi 任务确认",
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

export interface PetNoticeOutletDeps {
  gateway: PetNoticeWiringGateway;
  /** Durable gateway outbox publish (`publishGatewayControlEvent`), for replies to a route. */
  publishRoute(event: GatewayControlEventInput): Promise<void>;
  /** Reads validated attachment descriptors into sendable bytes (owner sends only). */
  materializeAttachments(
    attachments: readonly NoticeMediaAttachment[],
  ): Promise<OutgoingAttachment[]>;
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
   * Route notices are published to the durable gateway outbox (accepted =
   * enqueued); the deliveryKey derives from the record's claim key, so a
   * resend of the same record resumes the same delivery instead of repeating
   * it. Owner notices go to the channel's owner target, with the attachments
   * that target accepts.
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
      if (target.kind === "route") {
        const title = DESKTOP_TITLES[payload.kind];
        await deps.publishRoute({
          ...(key
            ? {
                deliveryKey: createHash("sha256")
                  .update("pet-notice-route\0")
                  .update(key)
                  .digest("hex"),
              }
            : {}),
          type: ROUTE_EVENT_TYPES[payload.kind] ?? "pet.task.reported",
          ...(title ? { title } : {}),
          text: body,
          ...(media?.button ? { button: media.button } : {}),
          ...(media?.attachments
            ? { attachments: media.attachments.map(({ sha256: _digest, ...file }) => file) }
            : {}),
          target: { channel: target.route.channel, target: target.route.target },
        });
        return { accepted: true };
      }
      const targetId = ownerChannels().find((entry) => entry.id === channel)?.targetId;
      if (!targetId) return { accepted: false, error: "no-owner-target" };
      const ownerTarget = ownerTargets().find((entry) => entry.id === targetId);
      // A group (or unconfirmed) owner target never gets private decision details.
      if (ownerTarget?.isDirect !== true && payload.nonDirectBody) body = payload.nonDirectBody;
      const files = attachmentsFor(ownerTarget, media?.attachments);
      let attachments: OutgoingAttachment[] = [];
      try {
        attachments = files.length > 0 ? await deps.materializeAttachments(files) : [];
      } catch (error) {
        // The text still matters; the files stay reachable from the Session.
        log("pet.notice.attachments_failed", { channel, error: errorText(error) });
      }
      const text = media?.button ? `${body}\n${media.button.text}：${media.button.url}` : body;
      await deps.gateway.sendOwnerMessage(
        targetId,
        text,
        attachments,
        key ? { idempotencyKey: key } : {},
      );
      return { accepted: true };
    } catch (error) {
      return { accepted: false, error: errorText(error) };
    }
  }

  return {
    ownerChannels,
    imChannels() {
      const result: Record<string, ImReadiness> = {};
      for (const entry of ownerChannels()) result[entry.id] = entry.ready;
      return result;
    },
    desktop,
    im,
  };
}
