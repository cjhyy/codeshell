import { expect, test } from "bun:test";
import { createSessionTranscriptApi } from "./session-transcript-api.js";

test("output reset subscription forwards only Session identity and releases its IPC listener", () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const ipc = {
    invoke: async () => undefined,
    on(channel: string, listener: (...args: any[]) => void) {
      listeners.set(channel, listener);
      return ipc;
    },
    removeListener(channel: string, listener: (...args: any[]) => void) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
      return ipc;
    },
  };
  const seen: string[] = [];
  const unsubscribe = createSessionTranscriptApi(ipc).onSessionOutputHistoryReset((id) =>
    seen.push(id),
  );
  const notify = listeners.get("sessions:outputHistoryReset")!;
  notify({}, { sessionId: "session" });
  notify({}, { sessionId: 7 });
  expect(seen).toEqual(["session"]);
  unsubscribe();
  expect(listeners.size).toBe(0);
});
