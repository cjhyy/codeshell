import { useEffect, useState } from "react";
import type { SkillSummary } from "../../main/skills-service";
import { SkillDetailModal } from "./SkillDetailModal";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

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
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        加载失败：{error} <Button size="sm" variant="outline" onClick={retry}>重试</Button>
      </div>
    );
  }
  if (skills === null) return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;

  const q = query.trim().toLowerCase();
  const rows = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q),
      )
    : skills;
  if (rows.length === 0)
    return <div className="p-4 text-sm text-muted-foreground">没有匹配的 skill</div>;

  return (
    <>
      <ul className="space-y-1">
        {rows.map((s) => (
          <li
            key={s.filePath}
            className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm hover:bg-accent"
            onClick={() => setOpen(s)}
          >
            <span className="text-lg">📄</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{s.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {(s.description ?? "").split("\n")[0]}
              </div>
            </div>
            <span className="text-xs text-muted-foreground">{s.source}</span>
            <span onClick={(e) => e.stopPropagation()}>
              <Switch checked={isEnabled(s)} onCheckedChange={(v) => onToggle(s, v)} />
            </span>
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
