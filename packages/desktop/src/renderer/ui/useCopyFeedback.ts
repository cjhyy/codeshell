import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";

/** Show success only after the clipboard accepts the text, with a bounded timer. */
export function useCopyFeedback(resetKey?: unknown) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef(0);

  useEffect(() => {
    setCopied(false);
    return () => {
      request.current += 1;
      clearTimeout(timer.current);
    };
  }, [resetKey]);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    const current = ++request.current;
    clearTimeout(timer.current);
    setCopied(false);
    const success = await copyText(text);
    if (current !== request.current) return success;
    setCopied(success);
    if (success) timer.current = setTimeout(() => setCopied(false), 1500);
    return success;
  }, []);

  return { copied, copy };
}
