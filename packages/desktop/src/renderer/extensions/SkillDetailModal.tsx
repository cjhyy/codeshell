import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";

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
    <div className="ext-modal-backdrop" onClick={onClose}>
      <div className="ext-modal" onClick={(e) => e.stopPropagation()}>
        <header className="ext-modal-head">
          <span className="ext-modal-title">{name}</span>
          <span className={`skill-source skill-source-${source}`}>{source}</span>
          <button className="ext-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="ext-modal-body">
          {error ? (
            <div className="customize-empty">读取失败：{error}</div>
          ) : body === null ? (
            <div className="customize-empty">加载中…</div>
          ) : (
            <Markdown text={body} />
          )}
        </div>
      </div>
    </div>
  );
}
