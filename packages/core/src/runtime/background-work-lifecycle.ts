import { channel } from "node:diagnostics_channel";

export interface BackgroundWorkChange {
  kind: "shell" | "job";
  workId: string;
  sessionId: string;
  startedAt: number;
}
const changes = channel("codeshell.background-work.lifecycle");
export function reportBackgroundWorkChange(kind: BackgroundWorkChange["kind"], workId: string, entry: { sessionId: string; startedAt: number }) {
  if (changes.hasSubscribers) changes.publish({kind,workId,sessionId:entry.sessionId,startedAt:entry.startedAt});
}
export function observeBackgroundWorkChange(listener: (change: BackgroundWorkChange) => void) {
  const receive = (data: unknown) => {
    if (isBackgroundWorkChange(data)) listener(data);
  };
  changes.subscribe(receive);
  return () => { changes.unsubscribe(receive); };
}
export function isBackgroundWorkChange(data: unknown): data is BackgroundWorkChange {
  if (!data || typeof data !== "object") return false;
  const e = data as Partial<BackgroundWorkChange>;
  return (e.kind === "shell" || e.kind === "job") && typeof e.workId === "string" && e.workId.length > 0 && e.workId.length <= 512 &&
    typeof e.sessionId === "string" && e.sessionId.length > 0 && e.sessionId.length <= 512 && Number.isSafeInteger(e.startedAt);
}
