import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

interface PendingRestore {
  frame: number;
  dispose: () => void;
  expectedDraft?: string;
}

export function useComposerCaretRestore(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  draft: string,
  scope: string,
) {
  const pending = useRef<PendingRestore | null>(null);
  const cancelCaretRestore = useCallback(() => {
    const previous = pending.current;
    if (!previous) return;
    pending.current = null;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(previous.frame);
    previous.dispose();
  }, []);

  useLayoutEffect(() => cancelCaretRestore, [scope, cancelCaretRestore]);
  useLayoutEffect(() => {
    const restore = pending.current;
    if (restore?.expectedDraft !== undefined && restore.expectedDraft !== draft)
      cancelCaretRestore();
  }, [draft, cancelCaretRestore]);

  const restoreCaret = useCallback(
    (position: number | "end", expectedDraft?: string) => {
      cancelCaretRestore();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const document = textarea.ownerDocument;
      const window = document.defaultView;
      const onFocus = (event: FocusEvent) => {
        if (event.target !== textarea) cancelCaretRestore();
      };
      const events = ["keydown", "beforeinput", "pointerdown"] as const;
      const restore: PendingRestore = {
        frame: 0,
        expectedDraft,
        dispose: () => {
          for (const event of events) document.removeEventListener(event, cancelCaretRestore, true);
          document.removeEventListener("focusin", onFocus, true);
          textarea.removeEventListener("blur", cancelCaretRestore);
          window?.removeEventListener("blur", cancelCaretRestore);
        },
      };
      // A pick's own mousedown/keydown has already run. Any later interaction
      // owns the selection and focus, even before React commits another draft.
      for (const event of events) document.addEventListener(event, cancelCaretRestore, true);
      document.addEventListener("focusin", onFocus, true);
      textarea.addEventListener("blur", cancelCaretRestore);
      window?.addEventListener("blur", cancelCaretRestore);
      pending.current = restore;
      restore.frame = requestAnimationFrame(() => {
        // Keep this guard even after cancelAnimationFrame: a superseded callback
        // must never act on a newer composer or steal an intentional selection.
        if (pending.current !== restore) return;
        pending.current = null;
        restore.dispose();
        if (
          textareaRef.current !== textarea ||
          !textarea.isConnected ||
          (expectedDraft !== undefined && textarea.value !== expectedDraft)
        )
          return;
        const caret = position === "end" ? textarea.value.length : position;
        textarea.focus();
        textarea.setSelectionRange(caret, caret);
      });
    },
    [textareaRef, cancelCaretRestore],
  );

  return { cancelCaretRestore, restoreCaret };
}
