import {
  injectMobileRunAndAwaitAcceptance,
  type MobileRunBridge,
  type MobileRunRequest,
  type MobileRunAcceptance,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import {
  assertOutputHistoryWriteAvailable,
  outputHistoryRecoveryRevision,
} from "../session-output-history-lease.js";

/** Capture before workspace/attachment awaits, not after a checkpoint has finished. */
export function captureMobileHistoryWrite(sessionId: string): () => void {
  const revision = outputHistoryRecoveryRevision(sessionId);
  assertOutputHistoryWriteAvailable(sessionId, revision);
  return () => assertOutputHistoryWriteAvailable(sessionId, revision);
}

export async function submitMobileHistoryWrite(
  assertCurrent: () => void,
  bridge: MobileRunBridge,
  meta: WorkerFrameMeta,
  request: MobileRunRequest,
  submit?: (request: MobileRunRequest) => Promise<MobileRunAcceptance>,
): Promise<MobileRunAcceptance> {
  try {
    assertCurrent();
  } catch {
    // No transport was touched, so this is a definite rejection rather than an uncertain send.
    return { ok: false, message: "会话历史已恢复，请核对当前内容后重新发送。" };
  }
  return submit ? submit(request) : injectMobileRunAndAwaitAcceptance(bridge, request, meta);
}
