import type { ChannelAdapter } from "./channel.js";
import type { GatewayNotificationTarget } from "./config.js";
import type { DesktopEventContext } from "./desktop-control-client.js";
import type { DesktopControlEvent } from "./protocol.js";

/**
 * Builds an at-least-once Desktop event sender. Successful targets are kept in
 * memory while a failed target is retried, so one unhealthy adapter does not
 * duplicate notifications on the adapters that already accepted the event.
 */
export function createDesktopNotificationHandler(
  adapters: readonly ChannelAdapter[],
  targets: readonly GatewayNotificationTarget[],
): (event: DesktopControlEvent, context: DesktopEventContext) => Promise<void> {
  const adapterByChannel = new Map(adapters.map((adapter) => [adapter.channel, adapter]));
  let currentEvent = "";
  let delivered = new Set<string>();

  return async (event, context) => {
    const eventKey = `${context.streamId}:${event.id}`;
    if (eventKey !== currentEvent) {
      currentEvent = eventKey;
      delivered = new Set<string>();
    }

    const results = await Promise.allSettled(
      targets.map(async ({ channel, target }) => {
        const targetKey = `${channel}\0${target}`;
        if (delivered.has(targetKey)) return;
        const adapter = adapterByChannel.get(channel);
        if (!adapter) throw new Error(`Notification adapter is unavailable: ${channel}`);
        await adapter.send(target, {
          text: event.text,
          ...(event.title ? { title: event.title } : {}),
          ...(event.button ? { button: event.button } : {}),
        });
        delivered.add(targetKey);
      }),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Desktop event ${eventKey} notification failed`);
    }
  };
}
