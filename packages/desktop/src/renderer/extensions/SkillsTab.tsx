import { useEffect, useState } from "react";
import type { SkillSummary } from "../../main/skills-service";
import { SkillDetailModal } from "./SkillDetailModal";

interface Props {
  cwd: string;
  query: string;
  isEnabled: (s: SkillSummary) => boolean;
  onToggle: (s: SkillSummary, next: boolean) => void;
}

export function SkillsTab({ cwd, query, isEnabled, onToggle }: Props) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<SkillSummary | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    setSkills(null);
    setError(null);
    window.codeshell
      .listSkills(cwd)
      .then((d) => {
        if (alive) setSkills(d);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, reloadKey]);

  if (error) {
    return (
      <div className="customize-empty">
        加载失败：{error} <button onClick={retry}>重试</button>
      </div>
    );
  }
  if (skills === null) return <div className="customize-empty">加载中…</div>;

  const q = query.trim().toLowerCase();
  const rows = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q),
      )
    : skills;
  if (rows.length === 0)
    return <div className="customize-empty">没有匹配的 skill</div>;

  return (
    <>
      <ul className="ext-list">
        {rows.map((s) => (
          <li
            key={s.filePath}
            className="ext-row"
            onClick={() => setOpen(s)}
          >
            <span className="ext-row-icon">📄</span>
            <div className="ext-row-main">
              <span className="ext-row-name">{s.name}</span>
              <span className="ext-row-desc">
                {(s.description ?? "").split("\n")[0]}
              </span>
            </div>
            <span className={`skill-source skill-source-${s.source}`}>
              {s.source}
            </span>
            <input
              type="checkbox"
              checked={isEnabled(s)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onToggle(s, e.target.checked)}
            />
          </li>
        ))}
      </ul>
      {open && (
        <SkillDetailModal
          name={open.name}
          filePath={open.filePath}
          source={open.source}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
