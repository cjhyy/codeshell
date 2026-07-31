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
  Check,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import type {
  MemoryLevel,
  MemoryScope,
  MemoryType,
  RendererMemoryEntry,
  RendererMemoryEntryFull,
  SaveMemoryInput,
} from "../../preload/types";
import { projectLabel, type TrackedProject } from "../projects";
import { cacheGet, cacheSet } from "./settingsCache";
import { ProjectPicker } from "./ProjectPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  activeProjectPath: string | null;
  projects: TrackedProject[];
}

const MEMORY_SCOPES: Array<{
  id: MemoryScope;
  labelKey: TranslationKey;
  helpKey: TranslationKey;
}> = [
  {
    id: "user",
    labelKey: "settingsX.memory.scopeUserLabel",
    helpKey: "settingsX.memory.scopeUserHelp",
  },
  {
    id: "dream",
    labelKey: "settingsX.memory.scopeDreamLabel",
    helpKey: "settingsX.memory.scopeDreamHelp",
  },
];

const MEMORY_TYPES: Array<{ id: MemoryType; labelKey: TranslationKey }> = [
  { id: "user", labelKey: "settingsX.memory.typeUser" },
  { id: "feedback", labelKey: "settingsX.memory.typeFeedback" },
  { id: "project", labelKey: "settingsX.memory.typeProject" },
  { id: "reference", labelKey: "settingsX.memory.typeReference" },
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

function MemoryTypeBadge({ type }: { type: MemoryType }) {
  const { t } = useT();
  const typeInfo = MEMORY_TYPES.find((candidate) => candidate.id === type);
  return (
    <span className={memoryTypeClassName(type)}>{typeInfo ? t(typeInfo.labelKey) : type}</span>
  );
}

type MemoryOrigin = NonNullable<RendererMemoryEntry["origin"]>;

function memoryOrigin(origin: RendererMemoryEntry["origin"]): MemoryOrigin {
  return origin ?? "manual";
}

function memoryUseCount(entry: RendererMemoryEntry): number {
  return entry.useCount ?? entry.usageCount ?? 0;
}

function memoryUpdateCount(entry: RendererMemoryEntry): number {
  return entry.updateCount ?? 0;
}

export function memoryDraftChanged(
  draft: SaveMemoryInput | null,
  baseline: SaveMemoryInput | null,
): boolean {
  if (!draft || !baseline) return false;
  const keys: Array<keyof SaveMemoryInput> = [
    "level",
    "scope",
    "name",
    "description",
    "type",
    "content",
    "cwd",
    "profileName",
    "pinned",
    "id",
    "origin",
  ];
  return keys.some((key) => draft[key] !== baseline[key]);
}

function memoryOriginLabelKey(origin: MemoryOrigin): TranslationKey {
  if (origin === "auto") return "settingsX.memory.originAutoBadge";
  if (origin === "dream") return "settingsX.memory.originDreamBadge";
  return "settingsX.memory.originManualBadge";
}

function memoryOriginTitleKey(origin: MemoryOrigin): TranslationKey {
  if (origin === "auto") return "settingsX.memory.originAutoTitle";
  if (origin === "dream") return "settingsX.memory.originDreamTitle";
  return "settingsX.memory.originManualTitle";
}

function memoryOriginClassName(origin: MemoryOrigin): string {
  return cn(
    "shrink-0 rounded px-1 text-[10px] tabular-nums",
    origin === "manual" && "bg-muted text-muted-foreground",
    origin === "auto" && "bg-status-warn/10 text-status-warn",
    origin === "dream" && "bg-primary/10 text-primary",
  );
}

export function MemoryEntryBadges({ entry }: { entry: RendererMemoryEntry }) {
  const { t } = useT();
  const origin = memoryOrigin(entry.origin);
  return (
    <>
      <span className={memoryOriginClassName(origin)} title={t(memoryOriginTitleKey(origin))}>
        {t(memoryOriginLabelKey(origin))}
      </span>
      <span
        className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground tabular-nums"
        title={t("settingsX.memory.useCountTitle")}
      >
        {t("settingsX.memory.useCountBadge", { count: memoryUseCount(entry) })}
      </span>
      <span
        className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground tabular-nums"
        title={t("settingsX.memory.updateCountTitle")}
      >
        {t("settingsX.memory.updateCountBadge", { count: memoryUpdateCount(entry) })}
      </span>
    </>
  );
}

export function buildEditDraft(
  selected: RendererMemoryEntryFull,
  level: MemoryLevel,
  scope: MemoryScope,
  cwd?: string,
  profileName?: string,
): SaveMemoryInput {
  return {
    id: selected.id,
    level,
    scope,
    name: selected.name,
    description: selected.description,
    type: selected.type,
    content: selected.content,
    cwd,
    profileName,
    pinned: selected.pinned,
    origin: scope === "user" ? "manual" : selected.origin,
  };
}

export function buildPinSaveInput(
  full: RendererMemoryEntryFull,
  pinned: boolean,
  level: MemoryLevel,
  scope: MemoryScope,
  cwd?: string,
  profileName?: string,
): SaveMemoryInput {
  return {
    id: full.id,
    level,
    scope,
    name: full.name,
    description: full.description,
    type: full.type,
    content: full.content,
    cwd,
    profileName,
    pinned,
    origin: full.origin,
  };
}

export function defaultCleanupSelection(entries: RendererMemoryEntry[]): Set<string> {
  return new Set(
    entries.filter((entry) => entry.origin === "auto" && !entry.pinned).map((e) => e.fileName),
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
 * Pick a store first: a project list (reusing the sidebar `projects`) with a
 * "全局" row on top. The global row → user-level memory (no project
 * dimension); a project row → that project's memory. After picking, the user
 * sees that store's entries (with the user/dream scope tab and a Dream
 * consolidation button), plus a "返回" link back to the list.
 */
export function MemorySection({ projects }: Props) {
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
          projects={projects}
          includeGlobal
          globalLabel={t("settingsX.memory.globalLabel")}
          globalHint={t("settingsX.memory.globalHint")}
          onSelect={(path) => {
            if (path === null) {
              setTarget({ level: "user", title: t("settingsX.memory.globalLabel") });
            } else {
              const repo = projects.find((r) => r.path === path);
              setTarget({
                level: "project",
                cwd: path,
                title: repo ? projectLabel(repo) : path,
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
      <MemoryStoreView level={target.level} cwd={target.cwd} />
    </section>
  );
}

/** Entry list + editor + Dream button for one memory store (level + cwd). */
export function MemoryStoreView({
  level,
  cwd,
  profileName,
  presentation = "default",
  onDirtyChange,
  onSavingChange,
}: {
  level: MemoryLevel;
  cwd?: string;
  profileName?: string;
  presentation?: "default" | "profile";
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const confirm = useConfirm();
  const { t } = useT();
  const [scope, setScope] = useState<MemoryScope>("user");
  // Seed from the last-loaded snapshot (settingsCache) so a remount (tab
  // switch) renders the list synchronously instead of an empty-state flash.
  const [entries, setEntries] = useState<RendererMemoryEntry[]>(
    () =>
      cacheGet<RendererMemoryEntry[]>(`memory:${level}:user:${cwd ?? ""}:${profileName ?? ""}`) ??
      [],
  );
  const [selected, setSelected] = useState<RendererMemoryEntryFull | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<SaveMemoryInput | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<SaveMemoryInput | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = React.useRef(false);
  const refreshGeneration = React.useRef(0);
  const entryReadGeneration = React.useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dreaming, setDreaming] = useState(false);
  const [cleanupReviewOpen, setCleanupReviewOpen] = useState(false);
  const [cleanupSelected, setCleanupSelected] = useState<Set<string>>(() => new Set());
  // 审批门: global memories the extractor flagged as "global" wait here. Only
  // meaningful at the global (user) level — pending is global-only.
  const [pending, setPending] = useState<RendererMemoryEntryFull[]>([]);
  const profilePresentation = presentation === "profile";
  // Dream is an automatic consolidation workspace for global/project memory.
  // Automatic jobs are deliberately forbidden from writing into a digital
  // human's portable memory, so exposing an always-empty Dream tab here is a
  // dead end rather than a useful choice.
  const visibleMemoryScopes = profilePresentation
    ? MEMORY_SCOPES.filter((candidate) => candidate.id === "user")
    : MEMORY_SCOPES;
  const draftDirty = drafting && memoryDraftChanged(draft, draftBaseline);

  useEffect(() => {
    onDirtyChange?.(draftDirty);
    return () => onDirtyChange?.(false);
  }, [draftDirty, onDirtyChange]);

  useEffect(() => {
    onSavingChange?.(saving);
    return () => onSavingChange?.(false);
  }, [onSavingChange, saving]);

  const refreshPending = useCallback(async () => {
    if (level !== "user") return;
    try {
      setPending(await window.codeshell.listPendingMemory());
    } catch {
      /* best-effort — pending banner just stays empty */
    }
  }, [level]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const list = await window.codeshell.listMemory(level, scope, cwd, profileName);
      if (generation !== refreshGeneration.current) return;
      setEntries(list);
      cacheSet(`memory:${level}:${scope}:${cwd ?? ""}:${profileName ?? ""}`, list);
    } catch (e: unknown) {
      if (generation !== refreshGeneration.current) return;
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [level, scope, cwd, profileName]);

  useEffect(() => {
    // A store switch must not leave the previous scope's rows clickable while
    // the new list is in flight. Reuse only the matching cached snapshot.
    setEntries(
      cacheGet<RendererMemoryEntry[]>(
        `memory:${level}:${scope}:${cwd ?? ""}:${profileName ?? ""}`,
      ) ?? [],
    );
    void refresh();
    void refreshPending();
    entryReadGeneration.current += 1;
    setSelected(null);
    setDrafting(false);
    setDraft(null);
    setDraftBaseline(null);
    setNotice(null);
    setCleanupReviewOpen(false);
    setCleanupSelected(new Set());
    return () => {
      refreshGeneration.current += 1;
      entryReadGeneration.current += 1;
    };
  }, [refresh, refreshPending]);

  const approvePending = async (name: string): Promise<void> => {
    try {
      await window.codeshell.approvePendingMemory(name);
      await Promise.all([refreshPending(), refresh()]);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const demotePending = async (name: string): Promise<void> => {
    try {
      await window.codeshell.demotePendingMemory(name);
      await Promise.all([refreshPending(), refresh()]);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const rejectPending = async (name: string): Promise<void> => {
    try {
      await window.codeshell.rejectPendingMemory(name);
      await refreshPending();
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const promoteToGlobal = async (name: string): Promise<void> => {
    if (level !== "project" || !cwd) return;
    try {
      await window.codeshell.promoteMemoryToGlobal(cwd, name);
      setSelected(null);
      await refresh();
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const loadEntry = async (name: string): Promise<void> => {
    const generation = ++entryReadGeneration.current;
    setError(null);
    setDrafting(false);
    setDraft(null);
    setDraftBaseline(null);
    try {
      const e = await window.codeshell.readMemory(level, scope, name, cwd, profileName);
      if (generation !== entryReadGeneration.current) return;
      setSelected(e);
    } catch (e: unknown) {
      if (generation !== entryReadGeneration.current) return;
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const confirmDiscardDraft = async (): Promise<boolean> => {
    if (!draftDirty) return true;
    return confirm({
      title: t("settingsX.memory.discardTitle"),
      message: t("settingsX.memory.discardMessage"),
      confirmLabel: t("settingsX.memory.discard"),
      destructive: true,
    });
  };

  const openEntry = async (name: string): Promise<void> => {
    if (saving) return;
    if (!(await confirmDiscardDraft())) return;
    await loadEntry(name);
  };

  const startNew = async (): Promise<void> => {
    if (saving) return;
    if (!(await confirmDiscardDraft())) return;
    entryReadGeneration.current += 1;
    const next: SaveMemoryInput = {
      level,
      scope,
      name: "",
      description: "",
      type: level === "project" ? "project" : "user",
      content: "",
      cwd,
      profileName,
    };
    setDrafting(true);
    setSelected(null);
    setDraft(next);
    setDraftBaseline(next);
  };

  const startEdit = async (): Promise<void> => {
    if (!selected) return;
    if (!(await confirmDiscardDraft())) return;
    const next = buildEditDraft(selected, level, scope, cwd, profileName);
    setDrafting(true);
    setDraft(next);
    setDraftBaseline(next);
  };

  const cancelDraft = async (): Promise<void> => {
    if (!(await confirmDiscardDraft())) return;
    setDrafting(false);
    setDraft(null);
    setDraftBaseline(null);
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft || saveLock.current) return;
    if (!draft.name.trim()) {
      setError(t("settingsX.memory.nameRequired"));
      return;
    }
    saveLock.current = true;
    setSaving(true);
    setError(null);
    try {
      const payload: SaveMemoryInput = {
        ...draft,
        level,
        scope,
        cwd,
        profileName,
        origin: scope === "user" ? "manual" : draft.origin,
      };
      await window.codeshell.saveMemory(payload);
      await refresh();
      setDrafting(false);
      setDraft(null);
      setDraftBaseline(null);
      await loadEntry(payload.id ?? payload.name);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };

  const removeEntry = async (name: string): Promise<void> => {
    if (saving) return;
    const ok = await confirm({
      title: t("settingsX.memory.confirmDeleteTitle"),
      message: t("settingsX.memory.confirmDeleteMsg", { name }),
      detail: t("settingsX.memory.confirmDeleteDetail"),
      confirmLabel: t("settingsX.memory.delete"),
      destructive: true,
    });
    if (!ok) return;
    const deletingSelected = selected?.name === name;
    const fallbackName = deletingSelected
      ? entries.find((entry) => entry.name !== name)?.name
      : undefined;
    try {
      await window.codeshell.deleteMemory(level, scope, name, cwd, profileName);
      if (deletingSelected) setSelected(null);
      await refresh();
      if (fallbackName) await loadEntry(fallbackName);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const runDream = async (): Promise<void> => {
    if (level === "profile") return;
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

  /** User-reviewed cleanup: default-select only origin:auto && !pinned. */
  const cleanupEntries = useMemo(() => entries.filter((e) => e.origin === "auto"), [entries]);
  const defaultCleanupCount = useMemo(() => defaultCleanupSelection(entries).size, [entries]);
  const openCleanupReview = (): void => {
    setCleanupSelected(defaultCleanupSelection(entries));
    setCleanupReviewOpen(true);
    setNotice(null);
  };
  const cleanupAuto = async (): Promise<void> => {
    const selectedEntries = cleanupEntries.filter((e) => cleanupSelected.has(e.fileName));
    if (selectedEntries.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      for (const e of selectedEntries) {
        await window.codeshell.deleteMemory(level, scope, e.name, cwd, profileName);
      }
      setSelected(null);
      setCleanupReviewOpen(false);
      setCleanupSelected(new Set());
      await refresh();
      setNotice(t("settingsX.memory.cleanupDone", { count: selectedEntries.length }));
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
      await refresh();
    } finally {
      setLoading(false);
    }
  };

  const changeScope = async (next: MemoryScope): Promise<void> => {
    if (saving || next === scope || !(await confirmDiscardDraft())) return;
    setScope(next);
  };

  /** Pin/unpin = re-save with the flag flipped (content fetched on demand). */
  const togglePin = async (entry: RendererMemoryEntry): Promise<void> => {
    if (saving) return;
    setError(null);
    try {
      const full = await window.codeshell.readMemory(level, scope, entry.name, cwd, profileName);
      if (!full) return;
      await window.codeshell.saveMemory(
        buildPinSaveInput(full, !entry.pinned, level, scope, cwd, profileName),
      );
      await refresh();
      if (selected?.name === entry.name) await openEntry(entry.name);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          profilePresentation && "rounded-xl border border-border/70 bg-muted/15 p-3",
        )}
      >
        <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-background p-1">
          {visibleMemoryScopes.map((s) => (
            <Button
              key={s.id}
              type="button"
              variant={scope === s.id ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              title={t(s.helpKey)}
              disabled={saving}
              onClick={() => void changeScope(s.id)}
            >
              {t(s.labelKey)}
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
          {cleanupEntries.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={openCleanupReview}
              disabled={loading || dreaming}
              title={t("settingsX.memory.cleanupTitle")}
            >
              <Eraser size={12} />
              <span>{t("settingsX.memory.cleanupAuto", { count: defaultCleanupCount })}</span>
            </Button>
          )}
          {level !== "profile" && scope === "dream" && (
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
              <span>
                {dreaming ? t("settingsX.memory.dreaming") : t("settingsX.memory.dreamBtn")}
              </span>
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            onClick={() => void refresh()}
            disabled={saving || loading || dreaming}
            title={t("settingsX.memory.refresh")}
            aria-label={t("settingsX.memory.refresh")}
          >
            <RefreshCw size={12} />
          </Button>
          <Button
            type="button"
            variant={profilePresentation ? "solid" : "ghost"}
            size="sm"
            className="h-8 gap-1 px-3 text-xs"
            onClick={() => void startNew()}
            disabled={saving || dreaming}
          >
            <Plus size={12} />
            <span>{t("settingsX.memory.newBtn")}</span>
          </Button>
        </div>
      </div>

      {notice && (
        <div className="rounded-md bg-status-ok/10 p-2 text-sm text-status-ok">{notice}</div>
      )}
      {error && (
        <div className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">{error}</div>
      )}
      {cleanupReviewOpen && (
        <CleanupReview
          entries={cleanupEntries}
          selected={cleanupSelected}
          loading={loading}
          onToggle={(fileName) =>
            setCleanupSelected((prev) => {
              const next = new Set(prev);
              if (next.has(fileName)) next.delete(fileName);
              else next.add(fileName);
              return next;
            })
          }
          onCancel={() => {
            setCleanupReviewOpen(false);
            setCleanupSelected(new Set());
          }}
          onConfirm={() => void cleanupAuto()}
        />
      )}

      {/* 审批门: pending global candidates — only at the global (user) level.
          Nothing auto-lands the injected global store; the user approves here. */}
      {level === "user" && pending.length > 0 && (
        <div className="rounded-md border border-status-warn/40 bg-status-warn/5 p-2">
          <div className="mb-1.5 px-1 text-xs font-medium text-status-warn">
            {t("settingsX.memory.pendingHeader", { count: pending.length })}
          </div>
          <ul className="flex flex-col gap-1" role="list">
            {pending.map((p) => (
              <li key={p.fileName} className="flex items-start gap-1 rounded-md px-2 py-1.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <MemoryTypeBadge type={p.type} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {p.name}
                    </span>
                  </div>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {p.description}
                  </span>
                  {p.promotionReason && (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {p.promotionReason}
                    </span>
                  )}
                  {p.originProject && (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {p.originProject}
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-status-ok"
                  onClick={() => void approvePending(p.name)}
                  title={t("settingsX.memory.pendingApprove")}
                  aria-label={t("settingsX.memory.pendingApprove")}
                >
                  <Check size={13} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => void demotePending(p.name)}
                  title={t("settingsX.memory.pendingDemote")}
                  aria-label={t("settingsX.memory.pendingDemote")}
                >
                  <ArrowDown size={13} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-status-err"
                  onClick={() => void rejectPending(p.name)}
                  title={t("settingsX.memory.pendingReject")}
                  aria-label={t("settingsX.memory.pendingReject")}
                >
                  <X size={13} />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className={cn(
          "grid h-[min(60vh,560px)] min-h-[360px] grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,0.42fr)_1fr]",
          profilePresentation &&
            "mt-3 h-[min(55vh,560px)] min-h-[400px] lg:grid-cols-[minmax(250px,0.44fr)_1fr]",
        )}
      >
        {/* min-h-0 + the bounded grid height above let this list scroll on its own
            instead of growing the whole panel (which left it without a scrollbar). */}
        <ul
          className={cn(
            "flex min-h-0 flex-col gap-1 overflow-y-auto rounded-md border p-2",
            profilePresentation && "rounded-xl border-border/70 bg-muted/10 p-2.5",
          )}
          role="list"
        >
          {sortedEntries.length === 0 && !loading && (
            <li className="flex min-h-36 flex-col items-center justify-center p-4 text-center text-sm text-muted-foreground">
              <Sparkles size={18} className="mb-2 opacity-50" aria-hidden="true" />
              <span>
                {profilePresentation
                  ? t("digitalHumans.memory.empty")
                  : t("settingsX.memory.emptyScope")}
              </span>
            </li>
          )}
          {sortedEntries.map((e) => (
            <li
              key={e.fileName}
              className={cn(
                "flex items-start gap-1 rounded-lg border border-transparent px-2.5 py-2",
                selected?.fileName === e.fileName && "border-primary/20 bg-primary/5 shadow-sm",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                className="flex h-auto min-w-0 flex-1 flex-col items-stretch gap-1 px-0 py-0 text-left hover:bg-transparent"
                onClick={() => void openEntry(e.name)}
                disabled={saving}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {e.pinned && (
                    <Pin
                      size={11}
                      className="shrink-0 text-primary"
                      aria-label={t("settingsX.memory.pinned")}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {e.name}
                  </span>
                </span>
                {e.description && (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {e.description}
                  </span>
                )}
                <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1">
                  <MemoryTypeBadge type={e.type} />
                  <MemoryEntryBadges entry={e} />
                </span>
              </Button>
              {!profilePresentation ? (
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
              ) : null}
              {/* 手动「提升到全局」— only for project-level user entries. */}
              {level === "project" && scope === "user" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-primary"
                  onClick={() => void promoteToGlobal(e.name)}
                  aria-label={t("settingsX.memory.promoteToGlobal")}
                  title={t("settingsX.memory.promoteToGlobalTitle")}
                >
                  <ArrowUp size={12} />
                </Button>
              )}
              {!profilePresentation ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-status-err"
                  onClick={() => void removeEntry(e.name)}
                  aria-label={t("settingsX.memory.deleteTitle")}
                  title={t("settingsX.memory.deleteTitle")}
                >
                  <Trash2 size={12} />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>

        <div
          className={cn(
            "min-h-0 overflow-y-auto rounded-md border p-3",
            profilePresentation && "rounded-xl border-border/70 bg-background p-4",
          )}
        >
          {drafting && draft ? (
            <DraftEditor
              draft={draft}
              saving={saving}
              onChange={setDraft}
              onSave={() => void saveDraft()}
              onCancel={() => void cancelDraft()}
            />
          ) : selected ? (
            <ViewEntry
              entry={selected}
              onEdit={() => void startEdit()}
              onClose={() => setSelected(null)}
              onPin={() => void togglePin(selected)}
              onDelete={() => void removeEntry(selected.name)}
              friendly={profilePresentation}
            />
          ) : (
            <div className="flex h-full min-h-40 flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground">
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted">
                <Pencil size={16} aria-hidden="true" />
              </span>
              <p className="max-w-xs leading-6">{t("settingsX.memory.emptyDetail")}</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function CleanupReview({
  entries,
  selected,
  loading,
  onToggle,
  onCancel,
  onConfirm,
}: {
  entries: RendererMemoryEntry[];
  selected: Set<string>;
  loading: boolean;
  onToggle: (fileName: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  const unpinned = entries.filter((e) => !e.pinned);
  const pinned = entries.filter((e) => e.pinned);
  const renderRows = (rows: RendererMemoryEntry[]) =>
    rows.map((entry) => (
      <label
        key={entry.fileName}
        className="flex min-w-0 items-start gap-2 rounded px-1 py-1 text-xs"
      >
        <Checkbox
          className="mt-0.5"
          checked={selected.has(entry.fileName)}
          onCheckedChange={() => onToggle(entry.fileName)}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <MemoryTypeBadge type={entry.type} />
            {entry.pinned && <Pin size={11} className="shrink-0 text-primary" />}
            <span className="truncate font-medium text-foreground">{entry.name}</span>
          </span>
          {entry.description && (
            <span className="truncate text-muted-foreground">{entry.description}</span>
          )}
        </span>
      </label>
    ));

  return (
    <div className="rounded-md border border-status-warn/40 bg-status-warn/5 p-2">
      <div className="mb-1 text-xs font-medium text-status-warn">
        {t("settingsX.memory.cleanupReviewTitle")}
      </div>
      <div className="mb-2 text-xs text-muted-foreground">
        {t("settingsX.memory.cleanupReviewDesc")}
      </div>
      {unpinned.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 px-1 text-[10px] font-medium uppercase text-muted-foreground">
            {t("settingsX.memory.cleanupGroupDefault", { count: unpinned.length })}
          </div>
          {renderRows(unpinned)}
        </div>
      )}
      {pinned.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 px-1 text-[10px] font-medium uppercase text-muted-foreground">
            {t("settingsX.memory.cleanupGroupPinned", { count: pinned.length })}
          </div>
          {renderRows(pinned)}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
          {t("settingsX.memory.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-7 text-xs"
          onClick={onConfirm}
          disabled={loading || selected.size === 0}
        >
          {t("settingsX.memory.cleanupSelected", { count: selected.size })}
        </Button>
      </div>
    </div>
  );
}

function ViewEntry({
  entry,
  onEdit,
  onClose,
  onPin,
  onDelete,
  friendly = false,
}: {
  entry: RendererMemoryEntryFull;
  onEdit: () => void;
  onClose: () => void;
  onPin: () => void;
  onDelete: () => void;
  friendly?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col">
      <div className="mb-3 flex flex-wrap items-start gap-3 border-b border-border/60 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="truncate text-base">{entry.name}</strong>
            {entry.pinned && (
              <span className="flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                <Pin size={10} /> {t("settingsX.memory.pinned")}
              </span>
            )}
            <MemoryTypeBadge type={entry.type} />
          </div>
          {entry.description ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{entry.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {friendly ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={onPin}
            >
              {entry.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              <span>{entry.pinned ? t("settingsX.memory.unpin") : t("settingsX.memory.pin")}</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant={friendly ? "default" : "ghost"}
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            onClick={onEdit}
          >
            <Pencil size={12} />
            <span>{t("settingsX.memory.edit")}</span>
          </Button>
          {friendly ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-status-err"
              onClick={onDelete}
              aria-label={t("settingsX.memory.deleteTitle")}
              title={t("settingsX.memory.deleteTitle")}
            >
              <Trash2 size={13} />
            </Button>
          ) : null}
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
      <div className="mb-3 flex flex-wrap gap-1">
        <MemoryEntryBadges entry={entry} />
      </div>
      <div className="max-h-[38vh] overflow-auto rounded-xl border border-border/60 bg-muted/20 p-4 text-sm leading-6 whitespace-pre-wrap">
        {entry.content}
      </div>
      <details className="mt-3 rounded-lg border border-border/60 px-3 py-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t("settingsX.memory.details")}
        </summary>
        <MemoryEntryMeta entry={entry} />
      </details>
    </div>
  );
}

function MemoryEntryMeta({ entry }: { entry: RendererMemoryEntryFull }) {
  const { t } = useT();
  const origin = memoryOrigin(entry.origin);
  const rows: Array<{ label: string; value?: string | number }> = [
    { label: t("settingsX.memory.metaId"), value: entry.id },
    { label: t("settingsX.memory.metaOrigin"), value: t(memoryOriginLabelKey(origin)) },
    { label: t("settingsX.memory.metaCreatedAt"), value: entry.createdAt ?? entry.created },
    { label: t("settingsX.memory.metaUpdatedAt"), value: entry.updatedAt },
    { label: t("settingsX.memory.metaLastUsedAt"), value: entry.lastUsedAt ?? entry.lastUsed },
    { label: t("settingsX.memory.metaUseCount"), value: memoryUseCount(entry) },
    { label: t("settingsX.memory.metaUpdateCount"), value: memoryUpdateCount(entry) },
  ];
  return (
    <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
      {rows.map((row) => (
        <React.Fragment key={row.label}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 truncate font-mono text-foreground">{row.value ?? "-"}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function DraftEditor({
  draft,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: SaveMemoryInput;
  saving: boolean;
  onChange: (next: SaveMemoryInput) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs font-medium">{t("settingsX.memory.fieldName")}</span>
        <Input
          type="text"
          value={draft.name}
          disabled={saving}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder={t("settingsX.memory.nameHint")}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs font-medium">{t("settingsX.memory.fieldType")}</span>
        <SimpleSelect<MemoryType>
          value={draft.type}
          disabled={saving}
          onChange={(type) => onChange({ ...draft, type })}
          options={MEMORY_TYPES.map((mt) => ({ value: mt.id, label: t(mt.labelKey) }))}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm md:col-span-2">
        <span className="text-xs font-medium">{t("settingsX.memory.fieldDescription")}</span>
        <Input
          type="text"
          value={draft.description}
          disabled={saving}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          placeholder={t("settingsX.memory.descHint")}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm md:col-span-2">
        <span className="text-xs font-medium">{t("settingsX.memory.fieldContent")}</span>
        <Textarea
          value={draft.content}
          disabled={saving}
          rows={12}
          onChange={(e) => onChange({ ...draft, content: e.target.value })}
          placeholder={t("settingsX.memory.contentHint")}
          className="leading-6"
        />
      </label>
      <div className="flex justify-end gap-2 md:col-span-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t("settingsX.memory.cancel")}
        </Button>
        <Button type="button" variant="solid" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          <span>{saving ? t("settingsX.memory.saving") : t("settingsX.memory.save")}</span>
        </Button>
      </div>
    </div>
  );
}
