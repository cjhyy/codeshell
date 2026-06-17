import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { AgentSummary, AgentDefinitionInput } from "../../preload/types";
import { useConfirm } from "../ui/ConfirmDialog";
import { ProjectPicker } from "./ProjectPicker";
import { catalogModelOptions, type ModelInstance } from "./textConnections";
import { useRefreshOnSettingsChange } from "./useSettingsResource";
import type { CatalogEntry } from "../../preload/types";
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
import { useT } from "../i18n/I18nProvider";

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
  const { t } = useT();

  if (!target) {
    return (
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">{t("settingsX.agents.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("settingsX.agents.pickDesc")}</p>
        <ProjectPicker
          repos={repos}
          includeGlobal
          globalLabel={t("settingsX.agents.globalLabel")}
          globalHint={t("settingsX.agents.globalHint")}
          onSelect={(path) => {
            if (path === null) {
              setTarget({ level: "user", title: t("settingsX.agents.globalLabel") });
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
          <span>{t("settingsX.agents.backToList")}</span>
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
  // Which groups' "disabled" sub-section is expanded (key = group id). Disabled
  // agents are collapsed by default so they don't clutter the list.
  const [showDisabled, setShowDisabled] = useState<Record<string, boolean>>({});
  const confirm = useConfirm();
  const { t } = useT();

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await window.codeshell.listAgents(cwd);
      setAgents(list);
      // Global baseline always comes from user settings.
      const u = (await window.codeshell.getSettings("user")) ?? {};
      const da = (u as { disabledAgents?: unknown }).disabledAgents;
      setDisabled(Array.isArray(da) ? (da as string[]) : []);
      // Unified store: sub-agent model options come from text modelConnections
      // (key = connection instance id = engine pool key, so resolveChildLlm
      // resolves it). Replaces the legacy settings.models[] source.
      const conns = Array.isArray((u as { modelConnections?: unknown }).modelConnections)
        ? ((u as { modelConnections: ModelInstance[] }).modelConnections)
        : [];
      const catalog = (await window.codeshell.getModelCatalog().catch(() => [])) as CatalogEntry[];
      setModels(catalogModelOptions(conns, catalog).map((o) => ({ key: o.key, label: o.label })));
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

  // Load on mount + auto-refresh when catalog/settings change anywhere (one
  // place wires the listeners — see useRefreshOnSettingsChange).
  useRefreshOnSettingsChange(() => void load());

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

  // Group agents by source (项目内置 / 用户自定义 / 插件), then within each
  // group split enabled vs disabled. Disabled ones collapse by default so a
  // long list (esp. many plugins) stays scannable. Closed-plugin agents are
  // already filtered out upstream by listAgents (disabledPlugins).
  const groups = useMemo(() => {
    const GROUP_ORDER: Array<{ id: AgentSummary["source"]; label: string }> = [
      { id: "project", label: t("settingsX.agents.groupProject") },
      { id: "user", label: t("settingsX.agents.groupUser") },
      { id: "plugin", label: t("settingsX.agents.groupPlugin") },
    ];
    return GROUP_ORDER.map(({ id, label }) => {
      const members = agents.filter((a) => a.source === id);
      const enabled = members.filter((a) => effectiveEnabled(a.name));
      const disabledMembers = members.filter((a) => !effectiveEnabled(a.name));
      return { id, label, enabled, disabled: disabledMembers, total: members.length };
    }).filter((g) => g.total > 0);
    // effectiveEnabled depends on disabled/overrides/isProject; agents is the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, disabled, overrides, isProject]);

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
      title: t("settingsX.agents.confirmDeleteTitle", { name: a.name }),
      message: a.override
        ? t("settingsX.agents.confirmDeleteOverride")
        : t("settingsX.agents.confirmDeleteCustom"),
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
    if (a.source === "project" && !a.override)
      return { label: t("settingsX.agents.tagBuiltin"), variant: "outline" };
    if (a.override) return { label: t("settingsX.agents.tagOverridden"), variant: "default" };
    return { label: t("settingsX.agents.tagCustom"), variant: "secondary" };
  };

  const renderRow = (a: AgentSummary) => {
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
              aria-label={t("settingsX.agents.projectLevelToggleAria", { name: a.name })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent onClick={(e) => e.stopPropagation()}>
              <SelectItem value="inherit">
                {isGloballyDisabled(a.name)
                  ? t("settingsX.agents.inheritDisabled")
                  : t("settingsX.agents.inheritEnabled")}
              </SelectItem>
              <SelectItem value="on">{t("settingsX.agents.forceOn")}</SelectItem>
              <SelectItem value="off">{t("settingsX.agents.forceOff")}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Switch
            checked={enabled}
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={() => void toggleGlobal(a.name)}
            title={enabled ? t("settingsX.agents.enabled") : t("settingsX.agents.disabledHidden")}
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
  };

  return (
    <div className="flex h-full gap-4">
      {/* Left: agent list */}
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <Button
          size="sm"
          className="self-start gap-1.5"
          onClick={startNew}
          title={t("settingsX.agents.newAgent")}
        >
          <Plus size={14} /> <span>{t("settingsX.agents.newAgent")}</span>
        </Button>
        <div className="space-y-3 overflow-y-auto">
          {groups.length === 0 && (
            <div className="px-2 py-4 text-sm text-muted-foreground">
              {t("settingsX.agents.noAgents")}
            </div>
          )}
          {groups.map((g) => {
            const open = showDisabled[g.id] ?? false;
            return (
              <div key={g.id} className="space-y-1">
                <div className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {g.label} <span className="text-muted-foreground/60">({g.total})</span>
                </div>
                <ul className="space-y-1">{g.enabled.map(renderRow)}</ul>
                {g.disabled.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                      onClick={() =>
                        setShowDisabled((s) => ({ ...s, [g.id]: !open }))
                      }
                    >
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span>{t("settingsX.agents.disabledCount", { count: g.disabled.length })}</span>
                    </button>
                    {open && <ul className="space-y-1">{g.disabled.map(renderRow)}</ul>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: editor form */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {error && <div className="mb-2 rounded-md bg-status-err/10 p-2 text-sm text-status-err">{error}</div>}
        {!draft ? (
          <div className="p-6">
            <div className="font-medium">{t("settingsX.agents.noneSelected")}</div>
            <div className="mt-1 text-sm text-muted-foreground">
              {t("settingsX.agents.noneSelectedHint")}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <header className="flex items-center gap-2">
              <h3 className="text-base font-semibold">
                {isNew
                  ? t("settingsX.agents.newAgent")
                  : draft.name || t("settingsX.agents.editorAgent")}
              </h3>
              {!isNew && current && (
                <Badge variant={tagFor(current).variant}>{tagFor(current).label}</Badge>
              )}
            </header>
            {nameLocked && (
              <p className="text-xs text-muted-foreground">
                {t("settingsX.agents.nameLockedHint")}
              </p>
            )}

            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">{t("settingsX.agents.fieldName")}</span>
                <Input
                  type="text"
                  value={draft.name}
                  disabled={nameLocked}
                  placeholder="researcher"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">
                  {t("settingsX.agents.fieldDescription")}
                </span>
                <Input
                  type="text"
                  value={draft.description}
                  placeholder="Read-only research — investigates and reports"
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">{t("settingsX.agents.fieldModel")}</span>
                <Select
                  value={draft.model ?? INHERIT}
                  onValueChange={(v) => setDraft({ ...draft, model: v === INHERIT ? undefined : v })}
                >
                  <SelectTrigger aria-label={t("settingsX.agents.modelAria")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>
                      {t("settingsX.agents.inheritParentModel")}
                    </SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">{t("settingsX.agents.fieldMaxTurns")}</span>
                <Input
                  type="number"
                  min={1}
                  value={draft.maxTurns ?? ""}
                  placeholder={t("settingsX.agents.maxTurnsPlaceholder")}
                  onChange={(e) =>
                    setDraft({ ...draft, maxTurns: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                />
              </label>
            </div>

            <div className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">
                {t("settingsX.agents.toolWhitelist")}{" "}
                <em className="not-italic text-xs">{t("settingsX.agents.toolWhitelistHint")}</em>
              </span>
              <div className="grid grid-cols-3 gap-2">
                {TOOL_CHOICES.map((tool) => {
                  const checked = (draft.tools ?? []).includes(tool);
                  return (
                    <label key={tool} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={checked}
                        onChange={() => {
                          const cur = new Set(draft.tools ?? []);
                          if (checked) cur.delete(tool);
                          else cur.add(tool);
                          const arr = [...cur];
                          setDraft({ ...draft, tools: arr.length ? arr : undefined });
                        }}
                      />
                      <span>{tool}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">{t("settingsX.agents.systemPrompt")}</span>
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
                  <Trash2 size={13} /> <span>{t("settingsX.agents.delete")}</span>
                </Button>
              )}
              <span className="flex-1" />
              <Button onClick={() => void save()}>{t("settingsX.agents.save")}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
