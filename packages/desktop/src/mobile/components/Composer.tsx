import { useRef } from "react";
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
    <div
      className="flex items-end gap-2 border-t border-border bg-card/80 p-2.5 backdrop-blur"
      style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}
    >
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
        className="max-h-40 min-h-[44px] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-50"
      />
      {running ? (
        <Button variant="outline" className="h-11" onClick={onStop}>
          停止
        </Button>
      ) : (
        <Button className="h-11" disabled={disabled} onClick={submit}>
          发送
        </Button>
      )}
    </div>
  );
}
