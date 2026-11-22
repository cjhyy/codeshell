import { createHash } from "node:crypto";
import { mutateJsonFile } from "@cjhyy/code-shell-core/internal";
import {
  parseGatewayControlEvent,
  type GatewayControlEvent,
} from "../../main/im-gateway-control-server.js";

export interface ImNoticeOwner {
  targetId: string;
  /** Safe text for a client that cannot revalidate a private destination. */
  nonDirectBody?: string;
}
interface PrivateCopy {
  key: string;
  owner: string;
  base: string;
  event: GatewayControlEvent;
}
type Copies = Map<string, PrivateCopy>;

function fingerprint(event: GatewayControlEvent) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.deliveryKey,
        event.type,
        event.target?.channel,
        event.target?.target,
        event.title,
        event.text,
        event.expiresAt,
        event.maxAttempts,
      ]),
    )
    .digest("hex");
}

/** A 0.11 reader sees only the safe presentation in its original outbox.
 * The current Host can restore the rich copy after a restart, and checks the
 * current target both when serving a poll and when a relay is about to send. */
export class PrivateImNotices {
  private copies?: Copies;
  constructor(
    private readonly path: string,
    private readonly isDirect: (
      id: string,
      target: NonNullable<GatewayControlEvent["target"]>,
    ) => boolean,
    private readonly isPending: (key: string) => boolean,
  ) {}
  private access(edit?: (entries: Copies) => void) {
    if (!edit && this.copies) return this.copies;
    this.copies = mutateJsonFile<Copies, Copies>(this.path, {
      maxBytes: 96 * 1024 * 1024,
      mode: 0o600,
      parse: (raw) => {
        const rows: unknown = raw === undefined ? [] : JSON.parse(raw);
        if (!Array.isArray(rows) || rows.length > 401) throw Error("Invalid private IM outbox");
        const entries: Copies = new Map();
        for (const item of rows as PrivateCopy[]) {
          const event = parseGatewayControlEvent(item.event);
          if (
            !event.deliveryKey ||
            item.key !== event.deliveryKey ||
            typeof item.owner !== "string" ||
            typeof item.base !== "string" ||
            entries.has(item.key)
          )
            throw Error("Invalid private IM delivery");
          entries.set(item.key, { ...item, event });
        }
        return entries;
      },
      serialize: (entries) => JSON.stringify([...entries.values()]),
      mutation: (entries) => {
        if (!edit) return { result: entries };
        for (const key of entries.keys()) if (!this.isPending(key)) entries.delete(key);
        edit(entries);
        return { value: entries, result: entries };
      },
    })!;
    return this.copies;
  }
  prepare(event: GatewayControlEvent, owner: ImNoticeOwner): GatewayControlEvent {
    if (!owner.nonDirectBody || !event.deliveryKey) return event;
    const { attachments: _files, button: _button, ...rest } = event;
    const safe = parseGatewayControlEvent({ ...rest, text: owner.nonDirectBody });
    const key = event.deliveryKey;
    this.access((entries) =>
      entries.set(key, { key, owner: owner.targetId, base: fingerprint(safe), event }),
    );
    return safe;
  }
  project(event: GatewayControlEvent): GatewayControlEvent | undefined {
    if (!event.target || event.maxAttempts === undefined || !event.deliveryKey) return event;
    try {
      const copy = this.access().get(event.deliveryKey);
      if (!copy) return event;
      if (copy.base !== fingerprint(event) || !this.isDirect(copy.owner, event.target)) return;
      return {
        ...event,
        text: copy.event.text,
        ...(copy.event.attachments ? { attachments: copy.event.attachments } : {}),
        ...(copy.event.button ? { button: copy.event.button } : {}),
      };
    } catch {
      return undefined;
    }
  }
  recover() {
    if ([...this.access().keys()].some((key) => !this.isPending(key))) this.access(() => {});
  }
  settled(key: string) {
    if (this.access().has(key)) this.access((entries) => entries.delete(key));
  }
}
