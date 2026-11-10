import {
  parseNoticeRuleUpsert,
  type BoundChannel,
  type NoticeChannel,
  type NoticeRuleUpsertReply,
  type RuleEffect,
} from "@cjhyy/code-shell-pet/protocol";
import type { HostActionHandler } from "../host-action-dispatch.js";
import type { ImGatewayOwnerChannel } from "../im-gateway-service.js";
import type { PetDeliveryResolver } from "./pet-delivery-plan.js";
import { quietHoursText, type PetNotificationSettings } from "./pet-notice-settings.js";
import type { NoticeRule, PetRuleStore } from "./pet-rule-store.js";

/** The IM a rule with this channel and target is predicted to use; undefined → desktop. */
export function predictedIm(
  channel: NoticeChannel,
  target: NoticeRule["target"],
  channels: readonly ImGatewayOwnerChannel[],
  lastOwnerInboundChannel: () => string | undefined,
): RuleEffect["im"] {
  if (channel === "desktop") return undefined;
  const describe = (id: string): RuleEffect["im"] => {
    const entry = channels.find((candidate) => candidate.id === id);
    return { channel: id, label: entry?.label ?? id, ready: entry?.ready ?? "unknown" };
  };
  // A notice from an IM conversation goes back to that conversation's channel.
  if (target.kind === "route") return describe(target.route.channel);
  if (channel !== "auto") return describe(channel);
  const usable = (id: string | undefined) =>
    id !== undefined && channels.some((entry) => entry.id === id && entry.ready !== "unavailable");
  const last = lastOwnerInboundChannel();
  if (usable(last)) return describe(last!);
  const first = channels.find((entry) => entry.ready !== "unavailable");
  return first ? describe(first.id) : undefined;
}

export interface PetNoticeRuleActionDeps {
  ruleStore: PetRuleStore;
  deliveries: Pick<PetDeliveryResolver, "ruleTarget">;
  ownerChannels(): ImGatewayOwnerChannel[];
  lastOwnerInboundChannel(): string | undefined;
  isEligibleSession(sessionId: string): boolean;
  settings(): PetNotificationSettings;
  /** A decision already pending in the Session may now have somewhere to go. */
  nudge(sessionId: string): void;
  now: () => number;
}

/** The NotifyMe host action (`PET_RULE_UPSERT_ACTION`): a Session arms a rule for itself. */
export function createNoticeRuleAction(deps: PetNoticeRuleActionDeps): HostActionHandler {
  const { ruleStore } = deps;
  return async (callerSessionId, args) => {
    const upsert = parseNoticeRuleUpsert(args);
    if (!upsert) throw new Error("invalid notice rule request");
    if (upsert.sessionId !== callerSessionId)
      throw new Error("a Session can only set notice rules for itself");
    if (!deps.isEligibleSession(upsert.sessionId)) throw new Error("unknown work Session");
    const channels = deps.ownerChannels();
    if (
      upsert.channel !== "auto" &&
      upsert.channel !== "desktop" &&
      !channels.some((channel) => channel.id === upsert.channel)
    ) {
      const reply: NoticeRuleUpsertReply = {
        ok: true,
        status: "unknown_channel",
        channels: channels
          .slice(0, 32)
          .map(({ id, label, ready }): BoundChannel => ({ id, label, ready })),
      };
      return reply;
    }
    await ruleStore.load();
    const target = await deps.deliveries.ruleTarget(upsert.sessionId);
    const rule = await ruleStore.upsertSessionRule({
      ...upsert,
      target,
      origin: "user",
      armedAt: deps.now(),
    });
    // A decision already pending in this Session may now have somewhere to go.
    deps.nudge(upsert.sessionId);
    const im = predictedIm(rule.channel, rule.target, channels, deps.lastOwnerInboundChannel);
    const quietHours = quietHoursText(deps.settings());
    const when = upsert.scope === "goal" ? "目标完成或卡住时" : "这个会话下一次完成实际工作后";
    const reply: NoticeRuleUpsertReply = {
      ok: true,
      status: "ok",
      effect: {
        ruleId: rule.id,
        // "auto" only uses the IM while the owner is away; never promise it outright.
        fires:
          rule.channel === "auto" && im
            ? `${when}（你在电脑前时发桌面，不在时发${im.label}）`
            : when,
        channel: rule.channel,
        ...(im ? { im } : {}),
        ...(quietHours ? { quietHours } : {}),
      },
    };
    return reply;
  };
}
