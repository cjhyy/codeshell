/** Stop fences submissions still awaiting workspace/model/attachment preparation. */
const pending = new WeakMap<object, Map<string, Set<{ cancelled: boolean }>>>();

export function captureMobileRunAdmission(owner: object, sessionId: string) {
  let sessions = pending.get(owner);
  if (!sessions) pending.set(owner, (sessions = new Map()));
  let entries = sessions.get(sessionId);
  if (!entries) sessions.set(sessionId, (entries = new Set()));
  const entry = { cancelled: false };
  entries.add(entry);
  return {
    assertCurrent() {
      if (entry.cancelled) throw new Error("该输入已被停止，请核对内容后重新发送。");
    },
    release() {
      entries.delete(entry);
      if (!entries.size && sessions.get(sessionId) === entries) sessions.delete(sessionId);
    },
  };
}

export function cancelMobileRunAdmissions(owner: object, sessionId: string): void {
  const sessions = pending.get(owner);
  for (const entry of sessions?.get(sessionId) ?? []) entry.cancelled = true;
  sessions?.delete(sessionId);
}
