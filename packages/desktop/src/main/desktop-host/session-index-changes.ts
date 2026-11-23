import { channel } from "node:diagnostics_channel";
import { isDesktopSessionId } from "../../shared/disk-session-query.js";

/** Consume the private worker notification here, before forwarding stdio to any UI. */
export function consumeSessionIndexNotification(
  message: unknown,
  changed?: (ids: string[]) => void,
): boolean {
  if (
    !message ||
    typeof message !== "object" ||
    !("method" in message) ||
    message.method !== "host/sessionIndexChanged"
  )
    return false;
  if (
    !("id" in message) &&
    "jsonrpc" in message &&
    message.jsonrpc === "2.0" &&
    "params" in message &&
    message.params &&
    typeof message.params === "object" &&
    "ids" in message.params &&
    Array.isArray(message.params.ids)
  ) {
    changed?.(message.params.ids.filter(isDesktopSessionId));
  }
  return true;
}

/** Writes are infrequent for most Sessions, but stream checkpoints may repeat one id
 * many times. Only this process's configured root can update its Desktop index. */
export function createSessionIndexChanges(root: string, send: (ids: string[]) => void) {
  const dirty = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    let ids: string[] = [];
    for (const id of dirty) {
      ids.push(id);
      if (ids.length === 256) {
        send(ids);
        ids = [];
      }
    }
    dirty.clear();
    if (ids.length) send(ids);
  }
  function add(ids: string[]) {
    for (const id of ids) if (isDesktopSessionId(id)) dirty.add(id);
    if (!timer && dirty.size) timer = setTimeout(flush, 50).unref();
  }
  const writes = channel("codeshell.session.state-committed");
  function onWrite(event: unknown) {
    if (
      event &&
      typeof event === "object" &&
      "root" in event &&
      event.root === root &&
      "id" in event &&
      isDesktopSessionId(event.id)
    )
      add([event.id]);
  }
  writes.subscribe(onWrite);
  return {
    add,
    flush,
    close() {
      writes.unsubscribe(onWrite);
      clearTimeout(timer);
      timer = undefined;
      dirty.clear();
    },
  };
}
