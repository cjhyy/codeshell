import { useEffect, useState } from "react";
import type { SkillSummary } from "../../main/skills-service";
import { SkillDetailModal } from "./SkillDetailModal";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import { useAlert } from "../ui/DialogProvider";
import { useT } from "../i18n/I18nProvider";
import { signalHotReload, runBatchUpdate, summarizeBatch } from "./applyUpdates";

interface Props {
  cwd: string;
  query: string;
  isEnabled: (s: SkillSummary) => boolean;
  onToggle: (s: SkillSummary, next: boolean) => void;
}

export function SkillsTab({ cwd, query, isEnabled, onToggle }: Props) {
  const { t } = useT();
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
      // Hot-reload: skills are disk-scanned live (next turn picks up the new
      // SKILL.md); fire the same event plugin update uses so any hooks/MCP a
      // skill bundle ships also re-reconcile on running sessions.
      if (r.updated) signalHotReload();
      toast(
        r.updated
          ? { message: t("ext.skills.updatedToast", { name: s.name }), variant: "success" }
          : { message: t("ext.skills.updateNoopToast", { name: s.name, reason: r.reason ?? "" }) },
      );
    } catch (e) {
      // Atomic in main — the old version is kept on failure.
      void alert({ title: t("ext.skills.updateFailedTitle"), message: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(null);
    }
  };

  const updateAll = async () => {
    const targets = (skills ?? []).filter((s) => updatable[s.filePath]);
    if (targets.length === 0) return;
    setBusy("__all__");
    try {
      const labelByPath = new Map(targets.map((s) => [s.filePath, s.name]));
      const outcomes = await runBatchUpdate(
        targets.map((s) => s.filePath),
        (fp) => labelByPath.get(fp) ?? fp,
        (fp) => window.codeshell.updateSkill(fp),
      );
      setReloadKey((k) => k + 1);
      if (outcomes.some((o) => o.updated)) signalHotReload();
      const summary = summarizeBatch(outcomes);
      toast({ message: summary.message, variant: summary.ok ? "success" : undefined });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        {t("ext.common.loadFailed", { error })} <Button size="sm" variant="outline" onClick={retry}>{t("ext.common.retry")}</Button>
      </div>
    );
  }
  if (skills === null) return <div className="p-4 text-sm text-muted-foreground">{t("ext.common.loading")}</div>;

  const q = query.trim().toLowerCase();
  const rows = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q),
      )
    : skills;
  if (rows.length === 0)
    return <div className="p-4 text-sm text-muted-foreground">{t("ext.skills.noMatch")}</div>;

  const updatableCount = rows.filter((s) => updatable[s.filePath]).length;

  return (
    <>
      {updatableCount > 1 && (
        <div className="mb-2 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy !== null}
            onClick={() => void updateAll()}
          >
            {busy === "__all__" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5" />
            )}
            {t("ext.skills.updateAll", { count: updatableCount })}
          </Button>
        </div>
      )}
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
                title={t("ext.skills.hasUpdateTip")}
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
