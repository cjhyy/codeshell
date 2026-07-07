import { useEffect, useRef, useState } from "react";
import { SendHorizonal, Square } from "lucide-react";
import { Button } from "@ui/button";

/** Bottom input bar: autosizing textarea + send + (when running) stop. */
export function Composer({
  disabled,
  running,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // `running` only flips true once the reducer processes stream_request_start —
  // there's a window after a send where the optimistic echo is already in the
  // chat but the button is still SEND-enabled, so a fast second tap would queue
  // a duplicate. `pending` closes that window locally until `running` arrives
  // (or a short safety timeout, in case the run rejects before starting).
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    if (running) {
      setPending(false);
      return;
    }
    const t = setTimeout(() => setPending(false), 5000);
    return () => clearTimeout(t);
  }, [pending, running]);

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const submit = () => {
    if (pending) return; // guard against double-submit before `running` lands
    const el = ref.current;
    if (!el) return;
    const t = el.value.trim();
    if (!t) return;
    onSend(t);
    setPending(true);
    el.value = "";
    autosize();
  };

  return (
    <div className="mobile-compose mobile-safe-bottom flex items-end gap-2 p-2.5">
      <textarea
        ref={ref}
        rows={1}
        disabled={disabled}
        onInput={autosize}
        // iOS Safari hygiene: stop password/contact autofill from hijacking the
        // box, and disable autocapitalize/autocorrect/spellcheck for a chat/code
        // input. `name`+`data-1p-ignore`/`data-lpignore` opt out of 1Password /
        // LastPass / iCloud Keychain heuristics.
        name="codeshell-prompt"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore="true"
        data-lpignore="true"
        enterKeyHint="enter"
        onKeyDown={(e) => {
          // Enter sends on wide screens (hardware keyboard); on phones the
          // virtual keyboard's return inserts a newline (use the button).
          if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 820px)").matches) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={disabled ? "未连接" : "发消息…"}
        // text-base (16px) is REQUIRED: iOS auto-zooms when a focused input's
        // font-size is < 16px, which is the "屏幕内容变大要缩小" symptom.
        className="mobile-compose-input max-h-40 min-h-[46px] min-w-0 flex-1 resize-none rounded-xl border px-3.5 py-2.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      {running ? (
        <Button variant="outline" className="h-[46px] shrink-0 rounded-xl px-3" onClick={onStop}>
          <Square />
          停止
        </Button>
      ) : (
        <Button className="h-[46px] shrink-0 rounded-xl px-3" disabled={disabled || pending} onClick={submit}>
          <SendHorizonal />
          发送
        </Button>
      )}
    </div>
  );
}
