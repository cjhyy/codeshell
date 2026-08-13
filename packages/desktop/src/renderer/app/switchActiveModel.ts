import type { Dispatch, SetStateAction } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";

import { isExternalRuntimeModelKey } from "../../shared/external-runtime-models";
import { forgetExternalRuntimeSession } from "../externalRuntimeRun";
import { bindEngineSession, type SessionIndex } from "../transcripts";
import type { TranscriptsAction } from "../transcriptsReducer";

interface Params {
  currentModelKey: string | null;
  nextModelKey: string;
  activeBucket: string;
  activeProjectId: string | null;
  activeProjectBucketSegment: string;
  activeSessionId: string | null;
  engineSessionId: string | null;
  promptTokens: number;
  setModelOverrides: Dispatch<SetStateAction<Record<string, string>>>;
  setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
  dispatch: Dispatch<TranscriptsAction>;
}

/** Keep native and external runtime lifecycles mutually exclusive for one Session. */
export function switchActiveModel({
  currentModelKey,
  nextModelKey,
  activeBucket,
  activeProjectId,
  activeProjectBucketSegment,
  activeSessionId,
  engineSessionId,
  promptTokens,
  setModelOverrides,
  setSessionIndices,
  dispatch,
}: Params): void {
  const wasExternal = isExternalRuntimeModelKey(currentModelKey);
  const nextExternal = isExternalRuntimeModelKey(nextModelKey);
  setModelOverrides((previous) => ({ ...previous, [activeBucket]: nextModelKey }));
  dispatch({
    type: "stream",
    bucket: activeBucket,
    event: {
      type: "usage_update",
      promptTokens,
      singleTurnPromptTokens: 0,
      singleTurnCacheReadTokens: 0,
      singleTurnCacheCreationTokens: 0,
    } as StreamEvent,
  });

  if (wasExternal && !nextExternal && activeSessionId) {
    forgetExternalRuntimeSession(activeSessionId);
    void window.codeshell.externalRuntime.stop(activeSessionId).catch((error) => {
      window.codeshell.log("external_runtime.model_switch_stop_failed", {
        sessionId: activeSessionId,
        error: String(error),
      });
    });
    const repaired = bindEngineSession(activeProjectId, activeSessionId, activeSessionId);
    setSessionIndices((previous) => ({
      ...previous,
      [activeProjectBucketSegment]: repaired,
    }));
  }

  if (engineSessionId && !nextExternal) {
    const targetEngineId = wasExternal && activeSessionId ? activeSessionId : engineSessionId;
    void window.codeshell
      .configure({ sessionId: targetEngineId, model: nextModelKey })
      .catch((error) => {
        window.codeshell.log("session.model_switch_failed", {
          sessionId: targetEngineId,
          model: nextModelKey,
          error: String(error),
        });
      });
  }
}
