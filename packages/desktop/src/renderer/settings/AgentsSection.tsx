import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import type { AgentSummary, AgentDefinitionInput } from "../../preload/types";
import { useConfirm } from "../ui/ConfirmDialog";
import { ProjectPicker } from "./ProjectPicker";
import { repoLabel, type Repo } from "../repos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  repos: Repo[];
}

// Tool names a user can grant a sub-agent. "Skill" is the on/off switch
// for skill usage. Keep roughly in sync with core BUILTIN_TOOLS.
const TOOL_CHOICES = [
  "Read", "Write", "Edit", "Grep", "Glob", "Bash",
  "WebSearch", "WebFetch", "Skill", "TodoWrite",
];

interface ModelOption { key: string; label: string; }

const INHERIT = "__inherit__";

/** Tri-state of a project's capabilityOverrides.agents[name]. */
type Override = "on" | "off" | "inherit";

/** Which store the user is editing. global = user-level; project = a repo. */
type Target =
  | { level: "user"; title: string }
  | { level: "project"; cwd: string; title: string };

/**
 * Sub-agents settings. Like 钩子/记忆, the page first shows a project list
 * (with a 全局 row): pick a store, then view/edit it.
 *
 *  - 全局: edit user-level agents; the per-agent switch writes the top-level
 *    `disabledAgents` denylist (the baseline for every project).
 *  - 项目: edit that project's agents; the per-agent control is TRI-STATE —
 *    继承全局 / 强制启用 / 强制禁用 — written to that project's
 *    `capabilityOverrides.agents` overlay so a project can flip a globally
 *    enabled agent off (or vice versa) without touching the global denylist.
 */
export function AgentsSection({ repos }: Props) {
  const [target, setTarget] = useState<Target | null>(null);

  if (!target) {
    return (
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">子代理</h3>
        <p className="text-sm text-muted-foreground">
          选择要管理的子代理:全局子代理所有项目共享;或选择某个项目,在项目级覆盖某个子代理的启用 / 禁用。
        </p>
        <ProjectPicker
          repos={repos}
          includeGlobal
          globalLabel="全局子代理"
          globalHint="所有项目共享 (~/.code-shell/agents)"
          onSelect={(path) => {
            if (path === null) {
              setTarget({ level: "user", title: "全局子代理" });
            } else {
              const repo = repos.find((r) => r.path === path);
              setTarget({ level: "project", cwd: path, title: repo ? repoLabel(repo) : path });
            }
          }}
        />
      </section>
    );
  }

  return (
    <section className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => setTarget(null)}
        >
          <ArrowLeft size={14} />
          <span>返回项目列表</span>
        </Button>
        <span className="truncate text-sm font-medium text-foreground">{target.title}</span>
      </div>
      <AgentsEditor target={target} />
    </section>
  );
}

/** Agent list + editor for one store (global or a single project). */
function AgentsEditor({ target }: { target: Target }) {
  const isProject = target.level === "project";
  const cwd = target.level === "project" ? target.cwd : "";
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  // Global denylist (always read — it's the baseline for project overlays too).
  const [disabled, setDisabled] = useState<string[]>([]);
  // Project overlay: name → "on" | "off" (absent = inherit).
  const [overrides, setOverrides] = useState<Record<string, "on" | "off">>({});
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
      // Global baseline always comes from user settings.
      const u = (await window.codeshell.getSettings("user")) ?? {};
      const da = (u as { disabledAgents?: unknown }).disabledAgents;
      setDisabled(Array.isArray(da) ? (da as string[]) : []);
      const ms = (u as { models?: unknown }).models;
      const arr = Array.isArray(ms) ? (ms as Array<{ key: string; label?: string }>) : [];
      setModels(arr.map((m) => ({ key: m.key, label: m.label || m.key })));
      // Project overlay (unmerged project file).
      if (isProject) {
        const p = (await window.codeshell.getSettings("project", cwd)) ?? {};
        const ov = (p as { capabilityOverrides?: { agents?: Record<string, unknown> } })
          .capabilityOverrides?.agents;
        const clean: Record<string, "on" | "off"> = {};
        if (ov && typeof ov === "object") {
          for (const [k, v] of Object.entries(ov)) {
            if (v === "on" || v === "off") clean[k] = v;
          }
        }
        setOverrides(clean);
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [cwd, isProject]);

  useEffect(() => { void load(); }, [load]);

  // Write scope for saveAgent/deleteAgent mirrors the read scope (listAgents(cwd)).
  const agentScope = (): { scope: "project"; cwd: string } | { scope: "user" } =>
    isProject ? { scope: "project", cwd } : { scope: "user" };

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

  const isGloballyDisabled = (name: string) => disabled.includes(name);

  /** Effective tri-state for an agent in project mode. */
  const overrideOf = (name: string): Override => overrides[name] ?? "inherit";

  /** Whether the agent is effectively enabled (for the row's dimmed style). */
  const effectiveEnabled = (name: string): boolean => {
    if (!isProject) return !isGloballyDisabled(name);
    const ov = overrideOf(name);
    if (ov === "on") return true;
    if (ov === "off") return false;
    return !isGloballyDisabled(name);
  };

  // Global mode: flip the top-level disabledAgents denylist.
  const toggleGlobal = async (name: string) => {
    const next = isGloballyDisabled(name)
      ? disabled.filter((n) => n !== name)
      : [...disabled, name];
    setDisabled(next);
    await window.codeshell.updateSettings("user", { disabledAgents: next });
    window.dispatchEvent(new Event("codeshell:settings-changed"));
  };

  // Project mode: set the tri-state overlay. "inherit" deletes the key (write
  // null — settings-service deepMerge treats null as a delete).
  const setOverride = async (name: string, value: Override) => {
    const next = { ...overrides };
    if (value === "inherit") delete next[name];
    else next[name] = value;
    setOverrides(next);
    await window.codeshell.updateSettings(
      "project",
      { capabilityOverrides: { agents: { [name]: value === "inherit" ? null : value } } },
      cwd,
    );
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
      const saved = await window.codeshell.saveAgent(draft, agentScope());
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
      await window.codeshell.deleteAgent(a.name, agentScope());
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

  const tagFor = (a: AgentSummary): { label: string; variant: "secondary" | "default" | "outline" } => {
    if (a.source === "project" && !a.override) return { label: "内置", variant: "outline" };
    if (a.override) return { label: "已覆盖", variant: "default" };
    return { label: "自定义", variant: "secondary" };
  };

  return (
    <div className="flex h-full gap-4">
      {/* Left: agent list */}
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <Button size="sm" className="self-start gap-1.5" onClick={startNew} title="新增子代理">
          <Plus size={14} /> <span>新增子代理</span>
        </Button>
        <ul className="space-y-1 overflow-y-auto">
          {agents.map((a) => {
            const enabled = effectiveEnabled(a.name);
            const tag = tagFor(a);
            return (
              <li
                key={a.name}
                className={
                  "flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-accent " +
                  (selected === a.name ? "bg-accent ring-1 ring-border " : "") +
                  (enabled ? "" : "opacity-50")
                }
                onClick={() => setSelected(a.name)}
              >
                {isProject ? (
                  <Select
                    value={overrideOf(a.name)}
                    onValueChange={(v) => void setOverride(a.name, v as Override)}
                  >
                    <SelectTrigger
                      className="h-7 w-[104px] shrink-0"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`${a.name} 项目级启停`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent onClick={(e) => e.stopPropagation()}>
                      <SelectItem value="inherit">
                        继承{isGloballyDisabled(a.name) ? "（禁用）" : "（启用）"}
                      </SelectItem>
                      <SelectItem value="on">强制启用</SelectItem>
                      <SelectItem value="off">强制禁用</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Switch
                    checked={enabled}
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={() => void toggleGlobal(a.name)}
                    title={enabled ? "已启用" : "已禁用（LLM 不可见）"}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.name}</div>
                  {a.description && (
                    <div className="truncate text-xs text-muted-foreground">{a.description}</div>
                  )}
                </div>
                <Badge variant={tag.variant}>{tag.label}</Badge>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Right: editor form */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {error && <div className="mb-2 rounded-md bg-status-err/10 p-2 text-sm text-status-err">{error}</div>}
        {!draft ? (
          <div className="p-6">
            <div className="font-medium">没有选中子代理</div>
            <div className="mt-1 text-sm text-muted-foreground">
              选择左侧一个子代理查看与编辑，或点「新增子代理」创建一个新的。
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <header className="flex items-center gap-2">
              <h3 className="text-base font-semibold">{isNew ? "新增子代理" : draft.name || "子代理"}</h3>
              {!isNew && current && (
                <Badge variant={tagFor(current).variant}>{tagFor(current).label}</Badge>
              )}
            </header>
            {nameLocked && (
              <p className="text-xs text-muted-foreground">
                内置子代理保留原名；保存时会在用户级生成同名覆盖文件，不会修改项目仓库里的原文件。
              </p>
            )}

            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">名称</span>
                <Input
                  type="text"
                  value={draft.name}
                  disabled={nameLocked}
                  placeholder="researcher"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">描述（LLM 选择该角色时看到的一句话）</span>
                <Input
                  type="text"
                  value={draft.description}
                  placeholder="Read-only research — investigates and reports"
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">模型</span>
                <Select
                  value={draft.model ?? INHERIT}
                  onValueChange={(v) => setDraft({ ...draft, model: v === INHERIT ? undefined : v })}
                >
                  <SelectTrigger aria-label="子代理使用的模型"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>跟随父模型（继承）</SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">最大轮数</span>
                <Input
                  type="number"
                  min={1}
                  value={draft.maxTurns ?? ""}
                  placeholder="留空 = 调用方决定"
                  onChange={(e) =>
                    setDraft({ ...draft, maxTurns: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </label>
            </div>

            <div className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">
                工具白名单 <em className="not-italic text-xs">不勾任何 = 继承父级全集</em>
              </span>
              <div className="grid grid-cols-3 gap-2">
                {TOOL_CHOICES.map((t) => {
                  const checked = (draft.tools ?? []).includes(t);
                  return (
                    <label key={t} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-primary"
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

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">系统提示词（角色的 system prompt）</span>
              <Textarea
                value={draft.systemPrompt}
                rows={12}
                spellCheck={false}
                placeholder="You are a research sub-agent. …"
                onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              />
            </label>

            <div className="flex items-center gap-2">
              {deletable && (
                <Button variant="ghost" className="gap-1.5 text-status-err" onClick={() => current && void remove(current)}>
                  <Trash2 size={13} /> <span>删除</span>
                </Button>
              )}
              <span className="flex-1" />
              <Button onClick={() => void save()}>保存</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
