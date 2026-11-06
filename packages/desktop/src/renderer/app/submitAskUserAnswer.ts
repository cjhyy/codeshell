/** A transport acknowledgement is not acceptance when Core returns an RPC error. */
export async function submitAskUserAnswer(
  sessionId: string | undefined,
  requestId: string,
  answer: string,
  isCurrent: () => boolean,
  skip?: boolean,
): Promise<boolean> {
  // Skip declines without an answer; Core tells the model the user skipped it.
  const response = skip
    ? sessionId
      ? await window.codeshell.approve(sessionId, requestId, "deny")
      : await window.codeshell.approve(requestId, "deny")
    : sessionId
      ? await window.codeshell.approve(sessionId, requestId, "approve", undefined, answer)
      : await window.codeshell.approve(requestId, "approve", undefined, answer);
  // Recovery or another device can retire this UI while the submission awaits.
  if (!isCurrent()) return false;
  if (response?.error) throw new Error(response.error.message);
  return true;
}
