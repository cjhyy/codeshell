import React, { useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  /** Shown above the input so the user knows what they're commenting on. */
  title: string;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}

/**
 * Codex-style "local comment" box: a small inline composer to attach a note to
 * a pinned location (a diff line, a file line). Cmd/Ctrl+Enter or 保存 submits;
 * Esc or 取消 dismisses.
 */
export function CommentBox({ title, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = (): void => {
    const v = value.trim();
    if (v) onSubmit(v);
  };

  return (
    <div className="my-1 rounded-md border border-border bg-card p-2 shadow-sm">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageSquarePlus className="h-3.5 w-3.5" />
        本地评论 · {title}
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="写下要让模型处理的内容…"
        className="h-16 w-full resize-none rounded border border-border bg-background p-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="mt-1 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" onClick={submit} disabled={!value.trim()}>
          添加到输入框
        </Button>
      </div>
    </div>
  );
}
