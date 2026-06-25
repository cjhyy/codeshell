import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Trash2,
  Pencil,
  Plus,
  X,
  Save,
  RefreshCw,
  Sparkles,
  Loader2,
  ArrowLeft,
  Pin,
  PinOff,
  Eraser,
} from "lucide-react";
import type {
  MemoryLevel,
  MemoryScope,
  MemoryType,
  RendererMemoryEntry,
  RendererMemoryEntryFull,
  SaveMemoryInput,
} from "../../preload/types";
import { repoLabel, type Repo } from "../repos";
import { cacheGet, cacheSet } from "./settingsCache";
import { ProjectPicker } from "./ProjectPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useConfirm } from "../ui/ConfirmDialog";
import { writeSettings } from "../settingsBus";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
  repos: Repo[];
}

const MEMORY_SCOPES: Array<{ id: MemoryScope; label: string; helpKey: TranslationKey }> = [
  { id: "user", label: "User", helpKey: "settingsX.memory.scopeUserHelp" },
  { id: "dream", label: "Dream", helpKey: "settingsX.memory.scopeDreamHelp" },
];

const MEMORY_TYPES: Array<{ id: MemoryType; label: string }> = [
  { id: "user", label: "user" },
  { id: "feedback", label: "feedback" },
  { id: "project", label: "project" },
  { id: "reference", label: "reference" },
];

function memoryTypeClassName(type: MemoryType): string {
  return cn(
    "shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase leading-none",
    type === "feedback" && "bg-status-warn/10 text-status-warn",
    type === "project" && "bg-status-running/10 text-status-running",
    type === "reference" && "bg-muted text-muted-foreground",
    type === "user" && "bg-primary/10 text-primary",
  );
}

/** Which memory store the user drilled into. */
interface Target {
  level: MemoryLevel;
  /** Concrete repo path for level="project"; undefined for the global level. */
  cwd?: string;
  /** Display title for the header. */
  title: string;
}

/**
 * Settings → 记忆 module.
 *
 * Pick a store first: a project list (reusing the sidebar `repos`) with a
 * "全局" row on top. The global row → user-level memory (no project
 * dimension); a project row → that project's memory. After picking, the user
 * sees that store's entries (with the user/dream scope tab and a Dream
 * consolidation button), plus a "返回" link back to the list.
 */
export function MemorySection({ repos }: Props) {
  const [target, setTarget] = useState<Target | null>(null);
  const { t } = useT();

  if (!target) {
    return (
      <section className="mb-6 flex flex-col gap-3">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
          {t("settingsX.memory.title")}
        </h3>
        <p className="m-0 text-xs text-muted-foreground">{t("settingsX.memory.pickDesc")}</p>
        <ProjectPicker
          repos={repos}
          includeGlobal
          globalLabel={t("settingsX.memory.globalLabel")}
          globalHint={t("settingsX.memory.globalHint")}
          onSelect={(path) => {
            if (path === null) {
              setTarget({ level: "user", title: t("settingsX.memory.globalLabel") });
            } else {
              const repo = repos.find((r) => r.path === path);
              setTarget({
                level: "project",
                cwd: path,
                title: repo ? repoLabel(repo) : path,
              });
            }
          }}
        />
      </section>
    );
  }

  return (
    <section className="mb-6 flex flex-col gap-3">
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => setTarget(null)}
        >
          <ArrowLeft size={14} />
          <span>{t("settingsX.memory.back")}</span>
        </Button>
        <span className="truncate text-sm font-medium text-foreground">{target.title}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {target.level === "project"
            ? t("settingsX.memory.levelProject")
            : t("settingsX.memory.levelGlobal")}
        </span>
      </div>
      <ProjectMemoryView level={target.level} cwd={target.cwd} />
    </section>
  );
}

/** Entry list + editor + Dream button for one memory store (level + cwd). */
function ProjectMemoryView({ level, cwd }: { level: MemoryLevel; cwd?: string }) {
  const confirm = useConfirm();
  const { t } = useT();
  const [scope, setScope] = useState<MemoryScope>("user");
  // Seed from the last-loaded snapshot (settingsCache) so a remount (tab
  // switch) renders the list synchronously instead of an empty-state flash.
  const [entries, setEntries] = useState<RendererMemoryEntry[]>(
    () => cacheGet<RendererMemoryEntry[]>(`memory:${level}:user:${cwd ?? ""}`) ?? [],
  );
  const [selected, setSelected] = useState<RendererMemoryEntryFull | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<SaveMemoryInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dreaming, setDreaming] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.codeshell.listMemory(level, scope, cwd);
      setEntries(list);
      cacheSet(`memory:${level}:${scope}:${cwd ?? ""}`, list);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [level, scope, cwd]);

  useEffect(() => {
    void refresh();
    setSelected(null);
    setDrafting(false);
    setNotice(null);
  }, [refresh]);

  const openEntry = async (name: string): Promise<void> => {
    setError(null);
    setDrafting(false);
    try {
      const e = await window.codeshell.readMemory(level, scope, name, cwd);
      setSelected(e);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const startNew = (): void => {
    setDrafting(true);
    setSelected(null);
    setDraft({
      level,
      scope,
      name: "",
      description: "",
      type: level === "project" ? "project" : "user",
      content: "",
      cwd,
    });
  };

  const startEdit = (): void => {
    if (!selected) return;
    setDrafting(true);
    setDraft({
      level,
      scope,
      name: selected.name,
      description: selected.description,
      type: selected.type,
      content: selected.content,
      cwd,
      // Editing must not silently unpin / relabel the entry.
      pinned: selected.pinned,
      origin: selected.origin,
    });
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError(t("settingsX.memory.nameRequired"));
      return;
    }
    setError(null);
    try {
      await window.codeshell.saveMemory({ ...draft, level, scope, cwd });
      await refresh();
      setDrafting(false);
      await openEntry(draft.name);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const removeEntry = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: t("settingsX.memory.confirmDeleteTitle"),
      message: t("settingsX.memory.confirmDeleteMsg", { name }),
      detail: t("settingsX.memory.confirmDeleteDetail"),
      confirmLabel: t("settingsX.memory.delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await window.codeshell.deleteMemory(level, scope, name, cwd);
      if (selected?.name === name) setSelected(null);
      await refresh();
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const runDream = async (): Promise<void> => {
    setDreaming(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.codeshell.runDream(level, cwd);
      await refresh();
      setNotice(
        result.summary?.trim()
          ? t("settingsX.memory.dreamDoneSummary", { summary: result.summary.trim() })
          : result.ran
            ? t("settingsX.memory.dreamDone")
            : t("settingsX.memory.dreamSkipped"),
      );
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setDreaming(false);
    }
  };

  const sortedEntries = useMemo(
    () =>
      entries.slice().sort((a, b) => {
        // 固定的排最前(feedback#18),组内仍按名称稳定排序。
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [entries],
  );

  // ---- 自动提取开关(settings.memories.autoExtract,全局 user 层) ----
  // Only surfaced in the GLOBAL memory view: the engine reads the merged
  // settings, so this one switch governs every project's extractor.
  const [autoExtract, setAutoExtract] = useState(true);
  useEffect(() => {
    if (level !== "user") return;
    void (async () => {
      try {
        const s = ((await window.codeshell.getSettings("user")) ?? {}) as {
          memories?: { autoExtract?: boolean };
        };
        setAutoExtract(s.memories?.autoExtract !== false);
      } catch {
        /* keep default-on */
      }
    })();
  }, [level]);
  const toggleAutoExtract = async (checked: boolean): Promise<void> => {
    setAutoExtract(checked);
    try {
      await writeSettings("user", { memories: { autoExtract: checked } });
    } catch (e: unknown) {
      setAutoExtract(!checked);
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  /** 批量清理:删掉本 scope 下所有「自动提取且未固定」的条目(soft-delete)。 */
  const autoEntries = useMemo(
    () => entries.filter((e) => e.origin === "auto" && !e.pinned),
    [entries],
  );
  const cleanupAuto = async (): Promise<void> => {
    if (autoEntries.length === 0) return;
    const ok = await confirm({
      title: t("settingsX.memory.confirmCleanupTitle"),
      message: t("settingsX.memory.confirmCleanupMsg", { count: autoEntries.length }),
      detail: t("settingsX.memory.confirmCleanupDetail"),
      confirmLabel: t("settingsX.memory.cleanup"),
      destructive: true,
    });
    if (!ok) return;
    setLoading(true);
    setError(null);
    try {
      for (const e of autoEntries) {
        await window.codeshell.deleteMemory(level, scope, e.name, cwd);
      }
      setSelected(null);
      await refresh();
      setNotice(t("settingsX.memory.cleanupDone", { count: autoEntries.length }));
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
      await refresh();
    } finally {
      setLoading(false);
    }
  };

  /** Pin/unpin = re-save with the flag flipped (content fetched on demand). */
  const togglePin = async (entry: RendererMemoryEntry): Promise<void> => {
    setError(null);
    try {
      const full = await window.codeshell.readMemory(level, scope, entry.name, cwd);
      if (!full) return;
      await window.codeshell.saveMemory({
        level,
        scope,
        name: full.name,
        description: full.description,
        type: full.type,
        content: full.content,
        cwd,
        pinned: !entry.pinned,
        origin: entry.origin, // keep provenance — pinning isn't authorship
      });
      await refresh();
      if (selected?.name === entry.name) await openEntry(entry.name);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-md border bg-muted/30 p-1">
          {MEMORY_SCOPES.map((s) => (
            <Button
              key={s.id}
              type="button"
              variant={scope === s.id ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              title={t(s.helpKey)}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {level === "user" && scope === "user" && (
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={t("settingsX.memory.autoExtractTitle")}
            >
              <Switch checked={autoExtract} onCheckedChange={(v) => void toggleAutoExtract(v)} />
              <span>{t("settingsX.memory.autoExtract")}</span>
            </label>
          )}
          {autoEntries.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => void cleanupAuto()}
              disabled={loading || dreaming}
              title={t("settingsX.memory.cleanupTitle")}
            >
              <Eraser size={12} />
              <span>{t("settingsX.memory.cleanupAuto", { count: autoEntries.length })}</span>
            </Button>
          )}
          {scope === "dream" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => void runDream()}
              disabled={dreaming || loading}
              title={t("settingsX.memory.dreamTitle")}
            >
              {dreaming ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              <span>{dreaming ? t("settingsX.memory.dreaming") : t("settingsX.memory.dreamBtn")}</span>
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            onClick={() => void refresh()}
            disabled={loading || dreaming}
            title={t("settingsX.memory.refresh")}
          >
            <RefreshCw size={12} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            onClick={startNew}
            disabled={dreaming}
          >
            <Plus size={12} />
            <span>{t("settingsX.memory.newBtn")}</span>
          </Button>
        </div>
      </div>

      {notice && <div className="rounded-md bg-status-ok/10 p-2 text-sm text-status-ok">{notice}</div>}
      {error && <div className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">{error}</div>}

      <div className="grid h-[min(60vh,560px)] min-h-[360px] grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,0.42fr)_1fr]">
        {/* min-h-0 + the bounded grid height above let this list scroll on its own
            instead of growing the whole panel (which left it without a scrollbar). */}
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto rounded-md border p-2" role="list">
          {sortedEntries.length === 0 && !loading && (
            <li className="p-4 text-center text-sm text-muted-foreground">
              {t("settingsX.memory.emptyScope")}
            </li>
          )}
          {sortedEntries.map((e) => (
            <li
              key={e.fileName}
              className={cn(
                "flex items-start gap-1 rounded-md px-2 py-1.5",
                selected?.fileName === e.fileName && "bg-accent",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                className="flex h-auto min-w-0 flex-1 flex-col items-stretch gap-0.5 px-0 py-0 text-left hover:bg-transparent"
                onClick={() => void openEntry(e.name)}
              >
                {/* Line 1: name takes the width; badges shrink and don't squeeze it out */}
                <span className="flex min-w-0 items-center gap-1.5">
                  {e.pinned && (
                    <Pin
                      size={11}
                      className="shrink-0 text-primary"
                      aria-label={t("settingsX.memory.pinned")}
                    />
                  )}
                  <span className={memoryTypeClassName(e.type)}>{e.type}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{e.name}</span>
                  {e.origin === "auto" && (
                    <span
                      className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
                      title={t("settingsX.memory.autoBadgeTitle")}
                    >
                      {t("settingsX.memory.autoBadge")}
                    </span>
                  )}
                  {typeof e.usageCount === "number" && e.usageCount > 0 && (
                    <span
                      className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground tabular-nums"
                      title={t("settingsX.memory.recalledTitle")}
                    >
                      {t("settingsX.memory.recalledBadge", { count: e.usageCount })}
                    </span>
                  )}
                </span>
                {/* Line 2: description, full row width, truncated */}
                {e.description && (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{e.description}</span>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => void togglePin(e)}
                aria-label={e.pinned ? t("settingsX.memory.unpin") : t("settingsX.memory.pin")}
                title={e.pinned ? t("settingsX.memory.unpin") : t("settingsX.memory.pinTitle")}
              >
                {e.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-status-err"
                onClick={() => void removeEntry(e.name)}
                aria-label="delete"
                title={t("settingsX.memory.deleteTitle")}
              >
                <Trash2 size={12} />
              </Button>
            </li>
          ))}
        </ul>

        <div className="min-h-0 overflow-y-auto rounded-md border p-3">
          {drafting && draft ? (
            <DraftEditor
              draft={draft}
              onChange={setDraft}
              onSave={() => void saveDraft()}
              onCancel={() => setDrafting(false)}
            />
          ) : selected ? (
            <ViewEntry entry={selected} onEdit={startEdit} onClose={() => setSelected(null)} />
          ) : (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {t("settingsX.memory.emptyDetail")}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ViewEntry({
  entry,
  onEdit,
  onClose,
}: {
  entry: RendererMemoryEntryFull;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong>{entry.name}</strong>
        {entry.pinned && (
          <span className="flex items-center gap-0.5 rounded bg-primary/10 px-1 text-[10px] text-primary">
            <Pin size={10} /> {t("settingsX.memory.pinned")}
          </span>
        )}
        {entry.origin === "auto" && (
          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
            {t("settingsX.memory.autoBadge")}
          </span>
        )}
        <span className={memoryTypeClassName(entry.type)}>{entry.type}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs" onClick={onEdit}>
            <Pencil size={12} />
            <span>{t("settingsX.memory.edit")}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            onClick={onClose}
            aria-label="close"
          >
            <X size={12} />
          </Button>
        </div>
      </div>
      <div className="mb-3 text-sm text-muted-foreground">{entry.description}</div>
      <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{entry.content}</pre>
    </div>
  );
}

function DraftEditor({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: SaveMemoryInput;
  onChange: (next: SaveMemoryInput) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs text-muted-foreground">name</span>
        <Input
          type="text"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder={t("settingsX.memory.nameHint")}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs text-muted-foreground">description</span>
        <Input
          type="text"
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          placeholder={t("settingsX.memory.descHint")}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs text-muted-foreground">type</span>
        <SimpleSelect<MemoryType>
          value={draft.type}
          onChange={(type) => onChange({ ...draft, type })}
          options={MEMORY_TYPES.map((mt) => ({ value: mt.id, label: mt.label }))}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm md:col-span-2">
        <span className="text-xs text-muted-foreground">content (markdown)</span>
        <Textarea
          value={draft.content}
          rows={14}
          onChange={(e) => onChange({ ...draft, content: e.target.value })}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="default" onClick={onCancel}>
          {t("settingsX.memory.cancel")}
        </Button>
        <Button type="button" variant="solid" onClick={onSave}>
          <Save size={12} />
          <span>{t("settingsX.memory.save")}</span>
        </Button>
      </div>
    </div>
  );
}
