/** A transport acknowledgement is not acceptance when Core returns an RPC error. */
export async function submitAskUserAnswer(
  sessionId: string | undefined,
  requestId: string,
  answer: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const response = sessionId
    ? await window.codeshell.approve(sessionId, requestId, "approve", undefined, answer)
    : await window.codeshell.approve(requestId, "approve", undefined, answer);
  // Recovery or another device can retire this UI while the submission awaits.
  if (!isCurrent()) return false;
  if (response?.error) throw new Error(response.error.message);
  return true;
}
