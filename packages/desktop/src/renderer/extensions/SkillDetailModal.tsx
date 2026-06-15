import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface Props {
  name: string;
  filePath: string;
  source: string;
  onClose: () => void;
}

export function SkillDetailModal({ name, filePath, source, onClose }: Props) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBody(null);
    setError(null);
    window.codeshell
      .readSkillBody(filePath)
      .then((t) => {
        if (alive) setBody(t);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [filePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="font-semibold">{name}</span>
          <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">{source}</span>
          <span className="flex-1" />
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </Button>
        </header>
        <div className="overflow-y-auto p-4">
          {error ? (
            <div className="text-sm text-muted-foreground">读取失败：{error}</div>
          ) : body === null ? (
            <div className="text-sm text-muted-foreground">加载中…</div>
          ) : (
            <Markdown text={body} />
          )}
        </div>
      </div>
    </div>
  );
}
