import { useEffect, useRef, useState } from "react";
import type { ReviewAiPromptRequest } from "../../shared/review";
import { requestComposerSeed } from "../chat/composerSeed";

type Phase = "idle" | "preparing" | "ready" | "truncated" | "error";

/** Latest-only preparation tied to the exact panel selection and Session. */
export function useReviewPrompt(sessionId: string | null, context: object) {
  const current = useRef(context);
  const sequence = useRef(0);
  const pending = useRef(false);
  const [state, setState] = useState<{ context: object; phase: Phase; error?: string }>({
    context,
    phase: "idle",
  });
  if (current.current !== context) {
    current.current = context;
    sequence.current += 1;
    pending.current = false;
  }
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  const prepare = async (request: ReviewAiPromptRequest): Promise<void> => {
    if (!sessionId || pending.current) return;
    const requestId = ++sequence.current;
    pending.current = true;
    setState({ context, phase: "preparing" });
    try {
      const result = await window.codeshell.prepareReviewPrompt(sessionId, request);
      if (current.current !== context || sequence.current !== requestId) return;
      if (!requestComposerSeed({ text: result.prompt, source: "code-review", sessionId })) {
        throw new Error("Could not add review draft to the active conversation");
      }
      setState({ context, phase: result.truncated ? "truncated" : "ready" });
    } catch (error) {
      if (current.current !== context || sequence.current !== requestId) return;
      setState({
        context,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (current.current === context && sequence.current === requestId) pending.current = false;
    }
  };
  return {
    phase: state.context === context ? state.phase : ("idle" as Phase),
    error: state.context === context ? state.error : undefined,
    prepare,
  };
}
