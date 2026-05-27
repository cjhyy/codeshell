import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentSummary, AgentDefinitionInput } from "../../preload/types";
import { useConfirm } from "../ui/ConfirmDialog";

interface Props {
  activeRepoPath: string | null;
}

// Tool names a user can grant a sub-agent. "Skill" here is the on/off
// switch for skill usage. Keep roughly in sync with core BUILTIN_TOOLS.
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
      const arr = Array.isArray(ms) ? (ms as Array<{ key: string; label?: string }>) : [];
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
    await window.codeshell.deleteAgent(a.name);
    await load();
    setSelected(null);
    setDraft(null);
  };

  // A built-in (project source) with no user override: name locked,
  // saving creates a user override file.
  const nameLocked = !!current && current.source === "project";
  const deletable = !!current && (current.source === "user" || current.override);

  return (
    <section className="settings-section ps-section customize-host">
      <div className="customize-three-pane">
        {/* Left: agent list */}
        <div className="customize-pane">
          <div className="customize-toolbar">
            <button className="approval-btn approve" onClick={startNew}>新增子代理</button>
          </div>
          <ul className="customize-plugin-list">
            {agents.map((a) => (
              <li
                key={a.name}
                className={`customize-plugin-row${selected === a.name ? " is-selected" : ""}`}
                onClick={() => setSelected(a.name)}
              >
                <input
                  type="checkbox"
                  className="customize-plugin-row-check"
                  checked={!isDisabled(a.name)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => void toggleDisabled(a.name)}
                  title={isDisabled(a.name) ? "已禁用（LLM 不可见）" : "已启用"}
                />
                <span style={{ flex: 1 }}>{a.name}</span>
                {a.source === "project" && !a.override && <span className="ps-badge">内置</span>}
                {a.override && <span className="ps-badge">已覆盖</span>}
                {a.source === "user" && !a.override && <span className="ps-badge">自定义</span>}
              </li>
            ))}
          </ul>
        </div>

        {/* Right: editor form (spans two columns) */}
        <div className="customize-pane" style={{ gridColumn: "span 2" }}>
          {error && <div className="view-error">{error}</div>}
          {!draft ? (
            <div className="mcp-empty">
              <div className="mcp-empty-hint">选择左侧一个子代理，或「新增子代理」。</div>
            </div>
          ) : (
            <div
              className="settings-section"
              style={{ gap: 12, display: "flex", flexDirection: "column" }}
            >
              <label>名称
                <input
                  type="text"
                  value={draft.name}
                  disabled={nameLocked}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              {nameLocked && (
                <div className="mcp-empty-hint">
                  内置子代理不可改名；保存会在用户级生成同名覆盖文件。
                </div>
              )}
              <label>描述
                <input
                  type="text"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              <label>模型
                <select
                  value={draft.model ?? INHERIT}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      model: e.target.value === INHERIT ? undefined : e.target.value,
                    })
                  }
                >
                  <option value={INHERIT}>跟随父模型（继承）</option>
                  {models.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </label>
              <label>最大轮数 (maxTurns)
                <input
                  type="number"
                  value={draft.maxTurns ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      maxTurns: e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                />
              </label>
              <fieldset>
                <legend>工具（不勾任何 = 继承父全集）</legend>
                {TOOL_CHOICES.map((t) => {
                  const checked = (draft.tools ?? []).includes(t);
                  return (
                    <label key={t} style={{ display: "inline-flex", gap: 4, marginRight: 12 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const cur = new Set(draft.tools ?? []);
                          if (checked) cur.delete(t); else cur.add(t);
                          const arr = [...cur];
                          setDraft({ ...draft, tools: arr.length ? arr : undefined });
                        }}
                      />
                      {t}
                    </label>
                  );
                })}
              </fieldset>
              <label>系统提示词
                <textarea
                  className="settings-editor"
                  value={draft.systemPrompt}
                  onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  rows={10}
                />
              </label>
              <div className="settings-toolbar">
                {deletable && (
                  <button
                    className="approval-btn deny"
                    onClick={() => current && void remove(current)}
                  >删除</button>
                )}
                <button className="approval-btn approve" onClick={() => void save()}>保存</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
