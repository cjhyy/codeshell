import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AgentSummary, AgentDefinitionInput } from "../../preload/types";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/ConfirmDialog";

interface Props {
  activeRepoPath: string | null;
}

// Tool names a user can grant a sub-agent. "Skill" is the on/off switch
// for skill usage. Keep roughly in sync with core BUILTIN_TOOLS.
const TOOL_CHOICES = [
  "Read", "Write", "Edit", "Grep", "Glob", "Bash",
  "WebSearch", "WebFetch", "Skill", "TodoWrite",
];

interface ModelOption { key: string; label: string; }

const INHERIT = "__inherit__";

export function AgentsSection({ activeRepoPath }: Props) {
  const cwd = activeRepoPath ?? "";
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDefinitionInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await window.codeshell.listAgents(cwd);
      setAgents(list);
      const s = (await window.codeshell.getSettings("user")) ?? {};
      const da = (s as { disabledAgents?: unknown }).disabledAgents;
      setDisabled(Array.isArray(da) ? (da as string[]) : []);
      const ms = (s as { models?: unknown }).models;
      const arr = Array.isArray(ms)
        ? (ms as Array<{ key: string; label?: string }>)
        : [];
      setModels(arr.map((m) => ({ key: m.key, label: m.label || m.key })));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);

  const current = useMemo(
    () => agents.find((a) => a.name === selected) ?? null,
    [agents, selected],
  );

  useEffect(() => {
    if (current) {
      setDraft({
        name: current.name,
        description: current.description,
        model: current.model,
        maxTurns: current.maxTurns,
        tools: current.tools,
        systemPrompt: current.systemPrompt,
      });
    }
  }, [current]);

  const isDisabled = (name: string) => disabled.includes(name);

  const toggleDisabled = async (name: string) => {
    const next = isDisabled(name)
      ? disabled.filter((n) => n !== name)
      : [...disabled, name];
    setDisabled(next);
    await window.codeshell.updateSettings("user", { disabledAgents: next });
    window.dispatchEvent(new Event("codeshell:settings-changed"));
  };

  const startNew = () => {
    setSelected(null);
    setDraft({ name: "", description: "", systemPrompt: "" });
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const saved = await window.codeshell.saveAgent(draft);
      await load();
      setSelected(saved.name);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const remove = async (a: AgentSummary) => {
    const ok = await confirm({
      title: `删除子代理 ${a.name}？`,
      message: a.override
        ? "这会删除你的覆盖文件，恢复为内置定义。"
        : "这会删除该自定义子代理。",
    });
    if (!ok) return;
    try {
      await window.codeshell.deleteAgent(a.name);
    } catch (err) {
      console.error("deleteAgent failed", err);
      return;
    }
    await load();
    setSelected(null);
    setDraft(null);
  };

  const nameLocked = !!current && current.source === "project";
  const deletable = !!current && (current.source === "user" || current.override);
  const isNew = draft !== null && current === null;

  // Source tag tone — project (built-in): muted; override: accent-tinted;
  // user-only custom: subtle "ok" tone.
  const tagFor = (a: AgentSummary): { label: string; tone: string } => {
    if (a.source === "project" && !a.override) return { label: "内置", tone: "muted" };
    if (a.override) return { label: "已覆盖", tone: "accent" };
    return { label: "自定义", tone: "ok" };
  };

  const modelOptions = useMemo(
    () => [
      { value: INHERIT, label: "跟随父模型（继承）" },
      ...models.map((m) => ({ value: m.key, label: m.label })),
    ],
    [models],
  );

  return (
    <section className="settings-section ps-section customize-host">
      <div className="customize-three-pane">
        {/* Left: agent list */}
        <div className="customize-pane">
          <div className="customize-toolbar">
            <button
              className="approval-btn approve agent-new-btn"
              onClick={startNew}
              title="新增子代理"
            >
              <Plus size={14} />
              <span>新增子代理</span>
            </button>
          </div>
          <ul className="customize-plugin-list">
            {agents.map((a) => {
              const off = isDisabled(a.name);
              const tag = tagFor(a);
              return (
                <li
                  key={a.name}
                  className={`customize-plugin-row agent-row${
                    selected === a.name ? " is-selected" : ""
                  }${off ? " is-off" : ""}`}
                  onClick={() => setSelected(a.name)}
                >
                  <input
                    type="checkbox"
                    className="customize-plugin-row-check"
                    checked={!off}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => void toggleDisabled(a.name)}
                    title={off ? "已禁用（LLM 不可见）" : "已启用"}
                  />
                  <div className="agent-row-main">
                    <div className="agent-row-name">{a.name}</div>
                    {a.description && (
                      <div className="agent-row-desc">{a.description}</div>
                    )}
                  </div>
                  <span className={`agent-tag agent-tag-${tag.tone}`}>{tag.label}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Right: editor form (spans two columns) */}
        <div className="customize-pane agent-editor-pane">
          {error && <div className="view-error">{error}</div>}
          {!draft ? (
            <div className="agent-empty">
              <div className="agent-empty-title">没有选中子代理</div>
              <div className="agent-empty-hint">
                选择左侧一个子代理查看与编辑，或点「新增子代理」创建一个新的。
              </div>
            </div>
          ) : (
            <div className="agent-editor">
              <header className="agent-editor-head">
                <h3 className="settings-section-title">
                  {isNew ? "新增子代理" : draft.name || "子代理"}
                </h3>
                {!isNew && current && (
                  <span className={`agent-tag agent-tag-${tagFor(current).tone}`}>
                    {tagFor(current).label}
                  </span>
                )}
              </header>
              {nameLocked && (
                <p className="settings-section-help">
                  内置子代理保留原名；保存时会在用户级生成同名覆盖文件，不会修改项目仓库里的原文件。
                </p>
              )}

              <div className="agent-form-grid">
                <label className="settings-field">
                  <span>名称</span>
                  <input
                    type="text"
                    value={draft.name}
                    disabled={nameLocked}
                    placeholder="researcher"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>描述（LLM 选择该角色时看到的一句话）</span>
                  <input
                    type="text"
                    value={draft.description}
                    placeholder="Read-only research — investigates and reports"
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>模型</span>
                  <Select
                    value={draft.model ?? INHERIT}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        model: v === INHERIT ? undefined : v,
                      })
                    }
                    options={modelOptions}
                    searchable={modelOptions.length > 8}
                    ariaLabel="子代理使用的模型"
                  />
                </label>
                <label className="settings-field">
                  <span>最大轮数</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.maxTurns ?? ""}
                    placeholder="留空 = 调用方决定"
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        maxTurns:
                          e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>

              <div className="settings-field">
                <span>工具白名单 <em className="agent-field-hint">不勾任何 = 继承父级全集</em></span>
                <div className="agent-tools-grid">
                  {TOOL_CHOICES.map((t) => {
                    const checked = (draft.tools ?? []).includes(t);
                    return (
                      <label key={t} className="settings-toggle-inline">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const cur = new Set(draft.tools ?? []);
                            if (checked) cur.delete(t);
                            else cur.add(t);
                            const arr = [...cur];
                            setDraft({ ...draft, tools: arr.length ? arr : undefined });
                          }}
                        />
                        <span>{t}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <label className="settings-field">
                <span>系统提示词（角色的 system prompt）</span>
                <textarea
                  value={draft.systemPrompt}
                  rows={12}
                  spellCheck={false}
                  placeholder="You are a research sub-agent. …"
                  onChange={(e) =>
                    setDraft({ ...draft, systemPrompt: e.target.value })
                  }
                />
              </label>

              <div className="settings-toolbar agent-toolbar">
                {deletable && (
                  <button
                    className="approval-btn deny"
                    onClick={() => current && void remove(current)}
                  >
                    <Trash2 size={13} />
                    <span>删除</span>
                  </button>
                )}
                <span className="agent-toolbar-spacer" />
                <button className="approval-btn approve" onClick={() => void save()}>
                  保存
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
