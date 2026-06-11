import { useEffect, useState } from "react";
import type { SkillSummary } from "../../main/skills-service";
import { SkillDetailModal } from "./SkillDetailModal";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import { useAlert } from "../ui/DialogProvider";

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
  // filePath → has-newer-commit-upstream. Filled in async after the list
  // renders; only GitHub-installed skills (with a source sidecar) ever flip
  // true, so the badge silently no-ops for local/plugin skills.
  const [updatable, setUpdatable] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const alert = useAlert();

  const retry = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    setSkills(null);
    setError(null);
    setUpdatable({});
    window.codeshell
      .listSkills(cwd)
      .then((d) => {
        if (!alive) return;
        setSkills(d);
        // Background, non-blocking per-skill probe (network for github skills;
        // fast no-op for everything else). Badges appear as checks return.
        for (const s of d) {
          window.codeshell
            .checkSkillUpdate(s.filePath)
            .then((r) => {
              if (alive && r.updateAvailable) {
                setUpdatable((m) => ({ ...m, [s.filePath]: true }));
              }
            })
            .catch(() => {
              /* check failure → no badge */
            });
        }
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [cwd, reloadKey]);

  const update = async (s: SkillSummary) => {
    setBusy(s.filePath);
    try {
      const r = await window.codeshell.updateSkill(s.filePath);
      setReloadKey((k) => k + 1);
      toast(
        r.updated
          ? { message: `已更新 “${s.name}”，重载后生效`, variant: "success" }
          : { message: `“${s.name}”：${r.reason}` },
      );
    } catch (e) {
      // Atomic in main — the old version is kept on failure.
      void alert({ title: "更新失败", message: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(null);
    }
  };

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
            {updatable[s.filePath] && (
              <Button
                size="icon"
                variant="ghost"
                title="有新版本，点击更新"
                className="text-status-running hover:text-status-running"
                disabled={busy === s.filePath}
                onClick={(e) => {
                  e.stopPropagation();
                  void update(s);
                }}
              >
                {busy === s.filePath ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUpCircle className="h-4 w-4" />
                )}
              </Button>
            )}
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
