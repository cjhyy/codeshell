import { useRef } from "react";
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

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const submit = () => {
    const el = ref.current;
    if (!el) return;
    const t = el.value.trim();
    if (!t) return;
    onSend(t);
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
        className="mobile-compose-input max-h-40 min-h-[46px] flex-1 resize-none rounded-xl border px-3.5 py-2.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      {running ? (
        <Button variant="outline" className="h-[46px] rounded-xl px-3" onClick={onStop}>
          <Square />
          停止
        </Button>
      ) : (
        <Button className="h-[46px] rounded-xl px-3" disabled={disabled} onClick={submit}>
          <SendHorizonal />
          发送
        </Button>
      )}
    </div>
  );
}
