import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AgentSummary, AgentDefinitionInput } from "../../preload/types";
import { useConfirm } from "../ui/ConfirmDialog";
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

  const tagFor = (a: AgentSummary): { label: string; variant: "secondary" | "default" | "outline" } => {
    if (a.source === "project" && !a.override) return { label: "内置", variant: "outline" };
    if (a.override) return { label: "已覆盖", variant: "default" };
    return { label: "自定义", variant: "secondary" };
  };

  return (
    <section className="flex h-full gap-4">
      {/* Left: agent list */}
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <Button size="sm" className="self-start gap-1.5" onClick={startNew} title="新增子代理">
          <Plus size={14} /> <span>新增子代理</span>
        </Button>
        <ul className="space-y-1 overflow-y-auto">
          {agents.map((a) => {
            const off = isDisabled(a.name);
            const tag = tagFor(a);
            return (
              <li
                key={a.name}
                className={
                  "flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-accent " +
                  (selected === a.name ? "bg-accent ring-1 ring-border " : "") +
                  (off ? "opacity-50" : "")
                }
                onClick={() => setSelected(a.name)}
              >
                <Switch
                  checked={!off}
                  onClick={(e) => e.stopPropagation()}
                  onCheckedChange={() => void toggleDisabled(a.name)}
                  title={off ? "已禁用（LLM 不可见）" : "已启用"}
                />
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
    </section>
  );
}
