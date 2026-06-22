import { useEffect, useState } from "react";
import type { SkillSummary } from "../../main/skills-service";
import { SkillDetailModal } from "./SkillDetailModal";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowUpCircle, FileText, Loader2, Plug, type LucideIcon } from "lucide-react";
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

function skillNamespace(name: string): string | null {
  const idx = name.indexOf(":");
  return idx > 0 ? name.slice(0, idx) : null;
}

function displaySkillName(s: SkillSummary): string {
  if (s.source !== "plugin") return s.name;
  const namespace = skillNamespace(s.name);
  return namespace ? s.name.slice(namespace.length + 1) : s.name;
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
  const standaloneRows = rows
    .filter((s) => s.source !== "plugin")
    .sort((a, b) => a.name.localeCompare(b.name));
  const pluginGroups = new Map<string, SkillSummary[]>();
  for (const s of rows.filter((skill) => skill.source === "plugin")) {
    const owner = skillNamespace(s.name) ?? t("ext.skills.unknownPlugin");
    const list = pluginGroups.get(owner) ?? [];
    list.push(s);
    pluginGroups.set(owner, list);
  }
  const pluginGroupEntries = [...pluginGroups.entries()]
    .map(([owner, list]) => [
      owner,
      list.sort((a, b) => displaySkillName(a).localeCompare(displaySkillName(b))),
    ] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  const sourceLabel = (s: SkillSummary) => {
    if (s.source === "project") return t("ext.skills.sourceProject");
    if (s.source === "user") return t("ext.skills.sourceUser");
    return t("ext.skills.sourcePlugin");
  };

  const renderSectionHeader = (
    Icon: LucideIcon,
    title: string,
    description: string,
    count: number,
  ) => (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <span className="flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Badge variant="secondary">{count}</Badge>
    </div>
  );

  const renderSkillRow = (s: SkillSummary) => {
    const isPluginSkill = s.source === "plugin";
    const owner = isPluginSkill ? skillNamespace(s.name) : null;
    return (
      <li
        key={s.filePath}
        className="flex cursor-pointer items-center gap-3 rounded-lg border bg-card p-3 text-sm hover:bg-accent/50"
        onClick={() => setOpen(s)}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          {isPluginSkill ? (
            <Plug className="h-4 w-4" aria-hidden="true" />
          ) : (
            <FileText className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate font-medium">{displaySkillName(s)}</div>
            {isPluginSkill ? (
              <Badge variant="info" className="shrink-0">{owner ?? t("ext.skills.unknownPlugin")}</Badge>
            ) : (
              <Badge variant={s.source === "project" ? "accent" : "secondary"} className="shrink-0">
                {sourceLabel(s)}
              </Badge>
            )}
          </div>
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
        <span onClick={(e) => e.stopPropagation()}>
          <Switch checked={isEnabled(s)} onCheckedChange={(v) => onToggle(s, v)} />
        </span>
      </li>
    );
  };

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
      <div className="space-y-5">
        {standaloneRows.length > 0 && (
          <section className="space-y-2">
            {renderSectionHeader(
              FileText,
              t("ext.skills.standaloneTitle"),
              t("ext.skills.standaloneDesc"),
              standaloneRows.length,
            )}
            <ul className="space-y-1">
              {standaloneRows.map(renderSkillRow)}
            </ul>
          </section>
        )}
        {pluginGroupEntries.length > 0 && (
          <section className="space-y-2">
            {renderSectionHeader(
              Plug,
              t("ext.skills.pluginTitle"),
              t("ext.skills.pluginDesc"),
              rows.length - standaloneRows.length,
            )}
            <div className="space-y-3">
              {pluginGroupEntries.map(([owner, list]) => (
                <div key={owner} className="space-y-1">
                  <div className="flex items-center gap-2 px-1">
                    <Badge variant="info">{owner}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {t("ext.skills.groupSkillCount", { count: list.length })}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {list.map(renderSkillRow)}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
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
