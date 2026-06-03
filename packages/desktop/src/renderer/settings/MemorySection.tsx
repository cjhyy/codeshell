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
import { ProjectPicker } from "./ProjectPicker";
import { Button } from "@/components/ui/button";
import { useConfirm } from "../ui/ConfirmDialog";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
  repos: Repo[];
}

const MEMORY_SCOPES: Array<{ id: MemoryScope; label: string; help: string }> = [
  { id: "user", label: "User", help: "用户手动维护的记忆条目" },
  { id: "dream", label: "Dream", help: "自动整理工作区(可清理)" },
];

const MEMORY_TYPES: Array<{ id: MemoryType; label: string }> = [
  { id: "user", label: "user" },
  { id: "feedback", label: "feedback" },
  { id: "project", label: "project" },
  { id: "reference", label: "reference" },
];

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

  if (!target) {
    return (
      <section className="settings-section memory-section">
        <h3 className="settings-section-title">记忆</h3>
        <p className="settings-section-help">
          选择要查看的记忆:全局记忆所有项目共享,或选择某个项目查看它专属的记忆。
        </p>
        <ProjectPicker
          repos={repos}
          includeGlobal
          globalLabel="全局记忆"
          globalHint="所有项目共享 (~/.code-shell/memory)"
          onSelect={(path) => {
            if (path === null) {
              setTarget({ level: "user", title: "全局记忆" });
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
    <section className="settings-section memory-section">
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => setTarget(null)}
        >
          <ArrowLeft size={14} />
          <span>返回</span>
        </Button>
        <span className="truncate text-sm font-medium text-foreground">{target.title}</span>
        <span className="memory-level-chip">
          {target.level === "project" ? "项目" : "全局"}
        </span>
      </div>
      <ProjectMemoryView level={target.level} cwd={target.cwd} />
    </section>
  );
}

/** Entry list + editor + Dream button for one memory store (level + cwd). */
function ProjectMemoryView({ level, cwd }: { level: MemoryLevel; cwd?: string }) {
  const confirm = useConfirm();
  const [scope, setScope] = useState<MemoryScope>("user");
  const [entries, setEntries] = useState<RendererMemoryEntry[]>([]);
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
    });
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError("name 不能为空");
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
      title: "删除记忆",
      message: `删除记忆「${name}」?`,
      detail: "会移到 memory-trash/,可手动恢复。",
      confirmLabel: "删除",
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
          ? `整理完成:${result.summary.trim()}`
          : result.ran
            ? "整理完成。"
            : "未执行(缺少记忆工具)。",
      );
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setDreaming(false);
    }
  };

  const sortedEntries = useMemo(
    () => entries.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [entries],
  );

  return (
    <>
      <div className="memory-toolbar">
        <div className="memory-scope-tabs">
          {MEMORY_SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`logs-bucket${scope === s.id ? " active" : ""}`}
              title={s.help}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="memory-toolbar-actions">
          {scope === "dream" && (
            <button
              type="button"
              className="memory-action"
              onClick={() => void runDream()}
              disabled={dreaming || loading}
              title="跑一次 LLM,对 dream 记忆做去重 / 合并 / 清理"
            >
              {dreaming ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
              <span>{dreaming ? "整理中…" : "整理 Dream"}</span>
            </button>
          )}
          <button
            type="button"
            className="memory-action"
            onClick={() => void refresh()}
            disabled={loading || dreaming}
            title="刷新"
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            className="memory-action"
            onClick={startNew}
            disabled={dreaming}
          >
            <Plus size={12} />
            <span>新建</span>
          </button>
        </div>
      </div>

      {notice && <div className="memory-notice">{notice}</div>}
      {error && <div className="memory-error">{error}</div>}

      <div className="memory-layout">
        <ul className="memory-list" role="list">
          {sortedEntries.length === 0 && !loading && (
            <li className="memory-empty">该 scope 下还没有记忆。</li>
          )}
          {sortedEntries.map((e) => (
            <li
              key={e.fileName}
              className={`memory-list-item${selected?.fileName === e.fileName ? " active" : ""}`}
            >
              <button
                type="button"
                className="memory-list-item-main"
                onClick={() => void openEntry(e.name)}
              >
                <span className={`memory-type-chip memory-type-${e.type}`}>{e.type}</span>
                <span className="memory-list-name">{e.name}</span>
                <span className="memory-list-desc">{e.description}</span>
              </button>
              <button
                type="button"
                className="memory-list-delete"
                onClick={() => void removeEntry(e.name)}
                aria-label="delete"
                title="删除"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>

        <div className="memory-detail">
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
            <div className="memory-empty">从左侧选择一条记忆查看,或点新建。</div>
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
  return (
    <div className="memory-view">
      <div className="memory-view-head">
        <strong>{entry.name}</strong>
        <span className={`memory-type-chip memory-type-${entry.type}`}>{entry.type}</span>
        <div className="memory-view-actions">
          <button type="button" className="memory-action" onClick={onEdit}>
            <Pencil size={12} />
            <span>编辑</span>
          </button>
          <button
            type="button"
            className="memory-action"
            onClick={onClose}
            aria-label="close"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="memory-view-desc">{entry.description}</div>
      <pre className="memory-view-content">{entry.content}</pre>
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
  return (
    <div className="memory-edit">
      <label className="memory-field">
        <span className="memory-field-label">name</span>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="kebab-case 唯一标识"
        />
      </label>
      <label className="memory-field">
        <span className="memory-field-label">description</span>
        <input
          type="text"
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          placeholder="一句话摘要,会出现在索引里"
        />
      </label>
      <label className="memory-field">
        <span className="memory-field-label">type</span>
        <select
          value={draft.type}
          onChange={(e) => onChange({ ...draft, type: e.target.value as MemoryType })}
        >
          {MEMORY_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="memory-field memory-field-content">
        <span className="memory-field-label">content (markdown)</span>
        <textarea
          value={draft.content}
          rows={14}
          onChange={(e) => onChange({ ...draft, content: e.target.value })}
        />
      </label>
      <div className="memory-edit-actions">
        <Button type="button" variant="default" onClick={onCancel}>
          取消
        </Button>
        <Button type="button" variant="solid" onClick={onSave}>
          <Save size={12} />
          <span>保存</span>
        </Button>
      </div>
    </div>
  );
}
