import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, Pencil, Plus, X, Save, RefreshCw } from "lucide-react";
import type {
  MemoryLevel,
  MemoryScope,
  MemoryType,
  RendererMemoryEntry,
  RendererMemoryEntryFull,
  SaveMemoryInput,
} from "../../preload/types";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
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

/**
 * Settings → 记忆 module. Two axes:
 *   - level (settings page scope chip): user (global) vs project
 *   - scope (this section's local tab): user vs dream
 *
 * Layout: list of entries on the left, detail / edit pane on the
 * right. New / edit / delete operate against the same MemoryManager
 * the LLM tools use, so the data is consistent across UI + tool
 * calls (both routes are managed by main/memory-service.ts).
 */
export function MemorySection({ scope: levelScope, activeRepoPath }: Props) {
  // levelScope is the settings page's "全局 / 当前项目" tab. Map it
  // to MemoryLevel directly.
  const level: MemoryLevel = levelScope === "project" ? "project" : "user";
  const cwd = level === "project" ? activeRepoPath ?? undefined : undefined;
  const [scope, setScope] = useState<MemoryScope>("user");
  const [entries, setEntries] = useState<RendererMemoryEntry[]>([]);
  const [selected, setSelected] = useState<RendererMemoryEntryFull | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<SaveMemoryInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const requireCwd = level === "project" && !activeRepoPath;

  const refresh = useCallback(async () => {
    if (requireCwd) {
      setEntries([]);
      return;
    }
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
  }, [level, scope, cwd, requireCwd]);

  useEffect(() => {
    void refresh();
    setSelected(null);
    setDrafting(false);
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
      type: "project",
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
      // Reopen the freshly-saved entry so the right pane reflects it.
      await openEntry(draft.name);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const removeEntry = async (name: string): Promise<void> => {
    if (!confirm(`删除记忆 "${name}"?(会移到 memory-trash/,可手动恢复)`)) return;
    try {
      await window.codeshell.deleteMemory(level, scope, name, cwd);
      if (selected?.name === name) setSelected(null);
      await refresh();
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const sortedEntries = useMemo(
    () => entries.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [entries],
  );

  return (
    <section className="settings-section memory-section">
      <h3 className="settings-section-title">记忆</h3>
      <p className="settings-section-help">
        持久化的记忆条目;
        {level === "project" ? "当前项目专属" : "所有项目共享"}。
      </p>

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
          <button
            type="button"
            className="memory-action"
            onClick={() => void refresh()}
            disabled={loading || requireCwd}
            title="刷新"
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            className="memory-action"
            onClick={startNew}
            disabled={requireCwd}
          >
            <Plus size={12} />
            <span>新建</span>
          </button>
        </div>
      </div>

      {requireCwd && (
        <div className="memory-empty">先在左侧选一个项目,才能查看项目记忆。</div>
      )}
      {error && <div className="memory-error">{error}</div>}

      <div className="memory-layout">
        <ul className="memory-list" role="list">
          {sortedEntries.length === 0 && !loading && !requireCwd && (
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
                <span className={`memory-type-chip memory-type-${e.type}`}>
                  {e.type}
                </span>
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
            <ViewEntry
              entry={selected}
              onEdit={startEdit}
              onClose={() => setSelected(null)}
            />
          ) : (
            <div className="memory-empty">从左侧选择一条记忆查看,或点新建。</div>
          )}
        </div>
      </div>
    </section>
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
        <span className={`memory-type-chip memory-type-${entry.type}`}>
          {entry.type}
        </span>
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
        <button type="button" className="memory-action" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="memory-action memory-action-primary"
          onClick={onSave}
        >
          <Save size={12} />
          <span>保存</span>
        </button>
      </div>
    </div>
  );
}
