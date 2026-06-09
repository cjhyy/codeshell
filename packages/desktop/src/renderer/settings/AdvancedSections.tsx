import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, Trash2 } from "lucide-react";
import { NO_REPO_KEY, type SessionIndex } from "../transcripts";
import { repoLabel, type Repo } from "../repos";
import { useConfirm, truncateTitle } from "../ui/ConfirmDialog";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConnectionsPanel } from "./SearchConnectionsPanel";
import {
  DEFAULT_GIT_PREFS,
  loadGitPrefs,
  saveGitPrefs,
  type GitPrefs,
} from "../gitPrefs";
import { writeSettings } from "../settingsBus";
import { ProjectPicker } from "./ProjectPicker";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import QRCode from "qrcode";

interface ScopedProps {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

/**
 * Auto-save hook for free-text settings fields.
 *
 * Debounces writes (default 600ms) while typing, and exposes a `flush` to save
 * immediately on blur — so a quick tab-away never loses the last keystrokes.
 * The whole personalization tab auto-saves; no Save buttons (a Switch toggles
 * instantly, text persists on pause/blur).
 */
function useDebouncedSave(
  persist: (value: string) => Promise<void> | void,
  delay = 600,
) {
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current !== null) {
      const value = pending.current;
      pending.current = null;
      void persistRef.current(value);
    }
  }, []);

  const schedule = useCallback(
    (value: string) => {
      pending.current = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const v = pending.current;
        pending.current = null;
        if (v !== null) void persistRef.current(v);
      }, delay);
    },
    [delay],
  );

  // Flush any pending write on unmount (e.g. switching tabs/scopes).
  useEffect(() => () => flush(), [flush]);

  return { schedule, flush };
}

/**
 * Settings → 自定义指令.
 *
 * One large textarea mapping to the agent's `appendSystemPrompt` — extra
 * instructions/context layered onto the system prompt for every conversation.
 * Auto-saves (debounced while typing, flushed on blur); no Save button.
 *
 * The richer instruction-file knobs (customSystemPrompt / instructions.fileName
 * / scanDirs / compatFileNames) were intentionally dropped from this tab to
 * match Codex; they remain in the settings schema and can be set via the config
 * file. Memory enable/skip/reset toggles live in the dedicated 记忆 tab.
 */
export function PersonalizationSection({ scope, activeRepoPath }: ScopedProps) {
  const [instructions, setInstructions] = useState("");

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const { schedule, flush } = useDebouncedSave((value) =>
    writeSettings(scope, { agent: { appendSystemPrompt: value } }, cwd),
  );

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const agent = objectOf(s.agent);
    setInstructions(stringOf(agent.appendSystemPrompt));
  };

  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">自定义指令</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          为 CodeShell 提供额外的说明和上下文,会附加到每次对话的系统提示中。
        </p>
      </div>
      <Textarea
        value={instructions}
        onChange={(e) => { setInstructions(e.target.value); schedule(e.target.value); }}
        onBlur={flush}
        placeholder="添加自定义指令…"
        className="min-h-[260px] resize-y leading-relaxed"
      />
    </section>
  );
}

/**
 * Settings → 个性化 (回复语言 + 称呼画像).
 *
 * Two stable preferences injected into every conversation (main agent and
 * subagents alike): `agent.responseLanguage` (single line) and
 * `agent.userProfile` (multi-line). Auto-saves (debounced while typing,
 * flushed on blur); no Save button — same pattern as 自定义指令 above.
 */
export function ResponsePrefsSection({ scope, activeRepoPath }: ScopedProps) {
  const [language, setLanguage] = useState("");
  const [profile, setProfile] = useState("");
  // Latest values held in refs so each field's save writes both keys without
  // racing the other field's debounce.
  const languageRef = useRef("");
  const profileRef = useRef("");
  languageRef.current = language;
  profileRef.current = profile;
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const { schedule, flush } = useDebouncedSave(() =>
    writeSettings(
      scope,
      { agent: { responseLanguage: languageRef.current, userProfile: profileRef.current } },
      cwd,
    ),
  );

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const agent = objectOf(s.agent);
    setLanguage(stringOf(agent.responseLanguage));
    setProfile(stringOf(agent.userProfile));
  };
  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">个性化</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          回复语言与称呼会作为稳定偏好注入每次对话(主对话与子代理均生效)。
        </p>
      </div>
      <Input
        value={language}
        onChange={(e) => { setLanguage(e.target.value); schedule(e.target.value); }}
        onBlur={flush}
        placeholder="回复语言,如:始终用简体中文"
      />
      <Textarea
        value={profile}
        onChange={(e) => { setProfile(e.target.value); schedule(e.target.value); }}
        onBlur={flush}
        placeholder="称呼 / 画像,如:叫我 maki,后端工程师"
        className="min-h-[120px] resize-y leading-relaxed"
      />
    </section>
  );
}

/**
 * Settings → 指令文件.
 *
 * CODESHELL.md is always read; these two toggles opt into compat reading of
 * other tools' instruction files. Stored under `agent.instructions.{compatClaude,
 * compatCodex}`; absent/undefined means enabled (default true), so we treat
 * `!== false` as on.
 */
export function InstructionFilesSection({ scope, activeRepoPath }: ScopedProps) {
  const [compatClaude, setCompatClaude] = useState(true);
  const [compatCodex, setCompatCodex] = useState(true);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const agent = objectOf(s.agent);
    const instr = objectOf(agent.instructions);
    setCompatClaude(instr.compatClaude !== false);
    setCompatCodex(instr.compatCodex !== false);
  };
  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  // Switches persist instantly on toggle.
  const persist = (claude: boolean, codex: boolean) =>
    void writeSettings(
      scope,
      { agent: { instructions: { compatClaude: claude, compatCodex: codex } } },
      cwd,
    );

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">指令文件</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          始终读取 CODESHELL.md。可选地兼容读取其他工具的指令文件。
        </p>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm text-foreground">
        <span>兼容 Claude(CLAUDE.md)</span>
        <Switch
          checked={compatClaude}
          onCheckedChange={(v) => { setCompatClaude(v); persist(v, compatCodex); }}
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm text-foreground">
        <span>兼容 Codex(AGENTS.md)</span>
        <Switch
          checked={compatCodex}
          onCheckedChange={(v) => { setCompatCodex(v); persist(compatClaude, v); }}
        />
      </label>
    </section>
  );
}

export function ShortcutsSection() {
  const rows = [
    ["⌘K", "打开命令面板"],
    ["⌘F", "搜索当前对话"],
    ["⌘P", "搜索全部 session"],
    ["⌘⇧N", "新窗口"],
    ["Enter", "发送消息"],
    ["Shift Enter", "输入换行"],
  ];
  return (
    <section className="settings-section">
      <h3 className="settings-section-title">键盘快捷键</h3>
      <div className="settings-table">
        {rows.map(([key, label]) => (
          <div className="settings-table-row" key={key}>
            <kbd>{key}</kbd>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Hooks are PROJECT-scoped only — they run shell commands on a specific repo,
 * so a global/user hook makes no sense. The page first shows a list of
 * projects (reusing the sidebar `repos`); clicking one drills into that
 * project's hooks. Hooks are read/written from `<repo>/.code-shell/settings.json`.
 */
export function HooksSection({ repos }: { repos: Repo[] }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selectedRepo = repos.find((r) => r.path === selectedPath) ?? null;

  if (!selectedPath) {
    return (
      <section className="settings-section">
        <h3 className="settings-section-title">钩子</h3>
        <p className="settings-section-help">
          钩子按项目维护。选择一个项目以查看 / 编辑它的钩子。
        </p>
        <ProjectPicker repos={repos} onSelect={(path) => setSelectedPath(path)} />
      </section>
    );
  }

  return (
    <section className="settings-section">
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => setSelectedPath(null)}
        >
          <ArrowLeft size={14} />
          <span>返回项目列表</span>
        </Button>
        <span className="truncate text-sm font-medium text-foreground">
          {selectedRepo ? repoLabel(selectedRepo) : selectedPath}
        </span>
      </div>
      <ProjectHooksEditor cwd={selectedPath} />
    </section>
  );
}

/** Hook list + add form for a single project (cwd is a concrete repo path). */
function ProjectHooksEditor({ cwd }: { cwd: string }) {
  const [hooks, setHooks] = useState<Array<Record<string, unknown>>>([]);
  const [draft, setDraft] = useState("{\n  \"event\": \"pre_tool_use\",\n  \"command\": \"echo '{}'\"\n}");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const s = (await window.codeshell.getSettings("project", cwd)) ?? {};
      setHooks(Array.isArray(s.hooks) ? (s.hooks as Array<Record<string, unknown>>) : []);
    } catch {
      setHooks([]);
    }
  };
  useEffect(() => { void load(); }, [cwd]);

  const persist = async (next: Array<Record<string, unknown>>) => {
    await writeSettings("project", { hooks: next }, cwd);
    setHooks(next);
  };

  const add = async () => {
    setError(null);
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      if (!parsed.event || !parsed.command) throw new Error("需要 event 和 command");
      await persist([...hooks, parsed]);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <>
      {hooks.length === 0 ? (
        <div className="approvals-empty">暂无 hook</div>
      ) : (
        <ul className="settings-list">
          {hooks.map((h, i) => (
            <li className="settings-list-row" key={i}>
              <strong>{stringOf(h.event)}</strong>
              <code>{stringOf(h.command)}</code>
              <button className="session-delete" onClick={() => void persist(hooks.filter((_, n) => n !== i))}>
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="settings-editor"
        style={{ minHeight: 120 }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {error && <div className="view-error">{error}</div>}
      <Button variant="solid" className="w-fit" onClick={() => void add()}>
        添加 hook
      </Button>
    </>
  );
}

export function ConnectionsSection(props: ScopedProps) {
  return <ConnectionsPanel {...props} />;
}

export function GitSection() {
  const [prefs, setPrefs] = useState<GitPrefs>(() => loadGitPrefs());

  useEffect(() => { setPrefs(loadGitPrefs()); }, []);

  const update = <K extends keyof GitPrefs>(key: K, value: GitPrefs[K]) => {
    setPrefs((c) => {
      const next = { ...c, [key]: value };
      saveGitPrefs(next);
      void window.codeshell.setGitPrefs?.(next);
      return next;
    });
  };

  return (
    <section className="settings-section">
      <ul className="settings-row-list">
        <GitRowShell
          title="分支前缀"
          help="在 codeshell 中创建工作树时使用的分支前缀（创建后会自动追加工作树名 + 短哈希）"
          control={
            <input
              className="settings-git-input"
              value={prefs.branchPrefix}
              placeholder={DEFAULT_GIT_PREFS.branchPrefix}
              onChange={(e) => update("branchPrefix", e.target.value)}
            />
          }
        />
        <GitRowShell
          title="自动清理过期工作树"
          help="启动 codeshell 时检查 .worktrees/ 目录，删除超过下方时长未修改的工作树（包含其本地分支）。"
          control={
            <Switch
              checked={prefs.autoDeleteWorktrees}
              onCheckedChange={(v) => update("autoDeleteWorktrees", v)}
            />
          }
        />
        <GitRowShell
          title="清理阈值"
          help="工作树空闲多久（按目录修改时间）后被自动清理。"
          control={
            <div className="settings-git-number">
              <input
                className="settings-git-input settings-git-input--number"
                type="number"
                value={prefs.autoDeleteWorktreesGraceMins}
                min={1}
                max={60 * 24 * 365}
                disabled={!prefs.autoDeleteWorktrees}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  if (Number.isFinite(n) && n >= 1) update("autoDeleteWorktreesGraceMins", n);
                }}
              />
              <span className="settings-git-number-suffix">分钟</span>
            </div>
          }
        />
      </ul>
    </section>
  );
}

function GitRowShell({
  title,
  help,
  control,
}: {
  title: string;
  help?: string;
  control: React.ReactNode;
}) {
  return (
    <li className="settings-git-row">
      <div className="settings-git-row-text">
        <div className="settings-git-row-title">{title}</div>
        {help && <div className="settings-git-row-help">{help}</div>}
      </div>
      <div className="settings-git-row-control">{control}</div>
    </li>
  );
}

type LocalEnvPlatform = "default" | "macos" | "linux" | "windows";

const LOCAL_ENV_TABS: Array<{ id: LocalEnvPlatform; label: string }> = [
  { id: "default", label: "默认" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
  { id: "windows", label: "Windows" },
];

const EMPTY_SCRIPTS: Record<LocalEnvPlatform, string> = {
  default: "",
  macos: "",
  linux: "",
  windows: "",
};

/**
 * Local environment is PROJECT-scoped (setup/cleanup scripts + env + sandbox
 * boundary live in a specific repo's `.code-shell/settings.json`). Like 钩子,
 * the page first shows a project list; clicking one drills into that project's
 * environment editor. This replaces the old "silently follow activeRepoPath"
 * behavior where the user couldn't tell (or switch) which project they edited.
 */
export function EnvironmentSection({ repos }: { repos: Repo[] }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selectedRepo = repos.find((r) => r.path === selectedPath) ?? null;

  if (!selectedPath) {
    return (
      <section className="settings-section">
        <h3 className="settings-section-title">本地环境</h3>
        <p className="settings-section-help">
          本地环境按项目维护(setup 脚本、KEY=VALUE 变量、沙箱边界)。选择一个项目以查看 / 编辑。
        </p>
        <ProjectPicker repos={repos} onSelect={(path) => setSelectedPath(path)} />
      </section>
    );
  }

  return (
    <section className="settings-section">
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => setSelectedPath(null)}
        >
          <ArrowLeft size={14} />
          <span>返回项目列表</span>
        </Button>
        <span className="truncate text-sm font-medium text-foreground">
          {selectedRepo ? repoLabel(selectedRepo) : selectedPath}
        </span>
      </div>
      <ProjectEnvEditor cwd={selectedPath} />
    </section>
  );
}

/** Local-environment editor for a single project (cwd is a concrete repo path). */
function ProjectEnvEditor({ cwd }: { cwd: string }) {
  const targetScope = "project" as const;
  const projectName = pathBasename(cwd);
  const [name, setName] = useState(projectName);
  const [setupTab, setSetupTab] = useState<LocalEnvPlatform>("default");
  // cleanupTab 暂时移除:清理脚本 UI 已隐藏(cleanup 未接)。恢复 UI 时一并恢复此行。
  const [setupScripts, setSetupScripts] = useState<Record<LocalEnvPlatform, string>>(EMPTY_SCRIPTS);
  const [cleanupScripts, setCleanupScripts] = useState<Record<LocalEnvPlatform, string>>(EMPTY_SCRIPTS);
  const [envText, setEnvText] = useState("");
  const [mode, setMode] = useState("auto");
  const [network, setNetwork] = useState("allow");
  const [writableRoots, setWritableRoots] = useState("");
  const [deniedReads, setDeniedReads] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = async () => {
    const s = (await window.codeshell.getSettings(targetScope, cwd)) ?? {};
    const localEnvironment = objectOf(s.localEnvironment);
    setName(stringOf(localEnvironment.name) || projectName);
    setSetupScripts(scriptMapOf(localEnvironment.setupScripts));
    setCleanupScripts(scriptMapOf(localEnvironment.cleanupScripts));
    setEnvText(envTextOf(localEnvironment.env));
    const sandbox = objectOf(s.sandbox);
    setMode(stringOf(sandbox.mode) || "auto");
    setNetwork(stringOf(sandbox.network) || "allow");
    setWritableRoots(arrayText(sandbox.writableRoots));
    setDeniedReads(arrayText(sandbox.deniedReads));
  };
  useEffect(() => { void load(); }, [cwd]);

  const save = async () => {
    setSaving(true);
    try {
      await writeSettings(
        targetScope,
        {
          localEnvironment: {
            name: name.trim() || projectName,
            setupScripts,
            cleanupScripts,
            env: parseEnvText(envText),
          },
          sandbox: {
            mode,
            network,
            writableRoots: lines(writableRoots),
            deniedReads: lines(deniedReads),
          },
        },
        cwd,
      );
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="env-settings-section">
      <div className="local-env-project-card">
        <Folder size={18} />
        <div>
          <strong>{projectName}</strong>
          <span>{cwd}</span>
        </div>
      </div>

      <label className="settings-field local-env-name">
        <span>名称</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={projectName} />
      </label>

      <LocalScriptEditor
        title="设置脚本"
        help="创建新工作树（EnterWorktree）时,会在工作树根目录自动跑一次对应平台的脚本(失败只警告不阻断)。"
        activeTab={setupTab}
        onTabChange={setSetupTab}
        scripts={setupScripts}
        onScriptChange={(tab, value) => setSetupScripts((prev) => ({ ...prev, [tab]: value }))}
        placeholder={'pip install -r requirements.txt\nnpm install\n./run/setup.sh'}
      />

      {/* 清理脚本 UI 暂时隐藏:cleanup 当前不自动收尾运行(决策未接),展示出来会
          误导用户以为配了就生效。state(cleanupScripts)+ 保存逻辑保留,接上 cleanup
          功能后直接恢复这段 <LocalScriptEditor title="清理脚本" …/> 即可,不丢已存数据。
          见 TODO-feedback.md「清理脚本(cleanup)未接但 UI 可配」。 */}

      <label className="settings-field local-env-vars">
        <span>变量</span>
        <Textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={"KEY=value\nNODE_ENV=development"}
          className="min-h-[120px] resize-y font-mono text-sm"
        />
        <span className="conn-field-hint">
          每行一个 KEY=VALUE。这些变量会注入该项目的 Bash 工具与后台 shell 执行环境(含工作树 setup 脚本)。MCP server 自己的环境变量仍在 MCP 服务器卡片里保存，只注入对应 server。
        </span>
      </label>

      <details className="local-env-advanced">
        <summary>沙箱边界（高级）</summary>
        <p>
          这里仍保存到 <code>sandbox</code> 字段；新对话、自动化和 Bash 工具启动时会读取它。
        </p>
      <div className="settings-form-grid">
        <label className="settings-field">
          <span>Sandbox</span>
          <Select
            value={mode}
            onChange={setMode}
            options={[
              { value: "auto", label: "auto", description: "按平台自动选择" },
              { value: "off", label: "off", description: "关闭沙箱" },
              { value: "seatbelt", label: "seatbelt", description: "macOS 沙箱" },
              { value: "bwrap", label: "bwrap", description: "Linux Bubblewrap" },
            ]}
          />
        </label>
        <label className="settings-field">
          <span>Network</span>
          <Select
            value={network}
            onChange={setNetwork}
            options={[
              { value: "allow", label: "allow", description: "允许访问网络" },
              { value: "deny", label: "deny", description: "拒绝网络访问" },
            ]}
          />
        </label>
        <label className="settings-field">
          <span>Writable roots</span>
          <textarea value={writableRoots} onChange={(e) => setWritableRoots(e.target.value)} />
          <span className="conn-field-hint">每行一个路径，支持 ${"{workspace}"}、~。这些路径会作为命令可写范围。</span>
        </label>
        <label className="settings-field">
          <span>Denied reads</span>
          <textarea value={deniedReads} onChange={(e) => setDeniedReads(e.target.value)} />
          <span className="conn-field-hint">每行一个路径，命令读取这些路径会被沙箱拦截。</span>
        </label>
      </div>
      </details>
      <div className="env-settings-actions">
        <Button variant="solid" className="w-fit" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中..." : "保存本地环境"}
        </Button>
        {savedAt && (
          <span className="env-settings-saved">
            已保存 · {new Date(savedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
    </div>
  );
}

function LocalScriptEditor({
  title,
  help,
  activeTab,
  onTabChange,
  scripts,
  onScriptChange,
  placeholder,
}: {
  title: string;
  help: string;
  activeTab: LocalEnvPlatform;
  onTabChange: (tab: LocalEnvPlatform) => void;
  scripts: Record<LocalEnvPlatform, string>;
  onScriptChange: (tab: LocalEnvPlatform, value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="local-env-script">
      <div className="local-env-script-head">
        <div>
          <h4>{title}</h4>
          <p>{help}</p>
        </div>
        <div className="local-env-tabs" role="tablist" aria-label={title}>
          {LOCAL_ENV_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <Textarea
        value={scripts[activeTab]}
        onChange={(e) => onScriptChange(activeTab, e.target.value)}
        placeholder={placeholder}
        className="min-h-[180px] resize-y font-mono text-sm"
      />
    </div>
  );
}

export function ToggleCapabilitySection({
  scope,
  activeRepoPath,
  settingKey,
  title,
  description,
}: ScopedProps & { settingKey: "browser" | "computer"; title: string; description: string }) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    setEnabled(objectOf(s[settingKey]).enabled === true);
  };
  useEffect(() => { void load(); }, [scope, activeRepoPath, settingKey]);

  const save = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    try {
      await writeSettings(scope, { [settingKey]: { enabled: next } }, cwd);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">{title}</h3>
      <p className="settings-section-help">{description}</p>
      <label className="settings-toggle-row">
        <span>{enabled ? "已启用" : "已禁用"}</span>
        <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => void save(e.target.checked)} />
      </label>
    </section>
  );
}

/**
 * Image attachment settings — currently just the OpenAI-side
 * `detail` hint (low / high / original) so users on a tight token
 * budget can flip every image to the cheap 85-token-per-image
 * rendering without giving up image attachments entirely.
 *
 * Anthropic providers ignore the field; we still surface it on the
 * user-level page because the active model can switch mid-session
 * and we'd rather have one place to control it than per-call args.
 */
export function ImageSettingsSection({ scope, activeRepoPath }: ScopedProps) {
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;
  const [detail, setDetail] = useState<"low" | "high" | "original" | "">("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const images = objectOf(s.images);
    const d = images.detail;
    setDetail(
      d === "low" || d === "high" || d === "original" ? d : "",
    );
  };
  useEffect(() => {
    void load();
  }, [scope, activeRepoPath]);

  const save = async (next: "low" | "high" | "original" | ""): Promise<void> => {
    setDetail(next);
    setSaving(true);
    try {
      const current = objectOf((await window.codeshell.getSettings(scope, cwd))?.images);
      const nextImages = next ? { ...current, detail: next } : { ...current, detail: undefined };
      await writeSettings(scope, { images: nextImages }, cwd);
    } finally {
      setSaving(false);
    }
  };

  const options: Array<{ id: "low" | "high" | "original" | ""; label: string; help: string }> = [
    { id: "", label: "默认", help: "由 provider 决定 (OpenAI = auto)" },
    { id: "low", label: "Low", help: "85 tokens/图 固定,最省" },
    { id: "high", label: "High", help: "服务端切 tile,默认体验" },
    { id: "original", label: "Original", help: "保留客户端尺寸,最贵" },
  ];

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">图片细节 (OpenAI 路径)</h3>
      <p className="settings-section-help">
        发给 OpenAI 兼容 provider 时图片的 detail 参数。
        {scope === "user" ? "全局默认,会被项目设置覆盖。" : "仅当前项目。"}
        Anthropic 路径不读这个字段。
      </p>
      <div className="settings-option-grid">
        {options.map((o) => (
          <button
            key={o.id || "default"}
            type="button"
            className={`settings-option-card${detail === o.id ? " active" : ""}`}
            disabled={saving}
            onClick={() => void save(o.id)}
          >
            <span className="settings-option-title">{o.label}</span>
            <span className="settings-option-desc">{o.help}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function ArchivedConversationsSection({
  repos,
  sessionIndices,
  onRestore,
  onDelete,
}: {
  repos: Repo[];
  sessionIndices: Record<string, SessionIndex>;
  onRestore: (repoId: string | null, sessionId: string) => void;
  onDelete: (repoId: string | null, sessionId: string) => void;
}) {
  const rows = useMemo(() => {
    const repoMap = new Map(repos.map((r) => [r.id, repoLabel(r)]));
    return Object.entries(sessionIndices).flatMap(([key, idx]) => {
      const repoId = key === NO_REPO_KEY ? null : key;
      const project = repoId ? repoMap.get(repoId) ?? "未知项目" : "无项目对话";
      return idx.sessions
        .filter((s) => s.archived)
        .map((s) => ({ repoId, project, session: s }));
    }).sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  }, [repos, sessionIndices]);

  const confirm = useConfirm();

  const removeOne = (repoId: string | null, sessionId: string, title: string): void => {
    void confirm({
      title: "永久删除",
      message: `永久删除「${truncateTitle(title, 28)}」？`,
      detail: "此操作不可撤销。",
      confirmLabel: "删除",
      destructive: true,
    }).then((ok) => {
      if (ok) onDelete(repoId, sessionId);
    });
  };

  const removeAll = (): void => {
    if (rows.length === 0) return;
    void confirm({
      title: "永久清空归档",
      message: `永久删除全部 ${rows.length} 条已归档对话？`,
      detail: "此操作不可撤销。",
      confirmLabel: "全部删除",
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      for (const row of rows) onDelete(row.repoId, row.session.id);
    });
  };

  return (
    <section className="archived-section">
      <div className="archived-section-toolbar">
        <button
          type="button"
          className="archived-clear-all"
          onClick={removeAll}
          disabled={rows.length === 0}
        >
          全部删除
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="archived-empty">还没有任何归档对话。</div>
      ) : (
        <ul className="archived-list">
          {rows.map(({ repoId, project, session }) => (
            <li key={`${repoId ?? NO_REPO_KEY}:${session.id}`} className="archived-row">
              <div className="archived-row-main">
                <span className="archived-row-title">{session.title}</span>
                <span className="archived-row-meta">
                  <span className="archived-row-time">{formatArchivedTime(session.updatedAt)}</span>
                  <span className="archived-row-dot">·</span>
                  <span className="archived-row-repo">{project}</span>
                </span>
              </div>
              <div className="archived-row-actions">
                <button
                  type="button"
                  className="archived-row-icon-btn"
                  onClick={() => removeOne(repoId, session.id, session.title)}
                  title="永久删除"
                  aria-label="永久删除"
                >
                  <Trash2 size={14} />
                </button>
                <button
                  type="button"
                  className="archived-row-link"
                  onClick={() => onRestore(repoId, session.id)}
                  title="取消归档"
                >
                  取消归档
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatArchivedTime(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}年${m}月${day}日，${hh}:${mm}`;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function scriptMapOf(value: unknown): Record<LocalEnvPlatform, string> {
  const obj = objectOf(value);
  return {
    default: stringOf(obj.default),
    macos: stringOf(obj.macos),
    linux: stringOf(obj.linux),
    windows: stringOf(obj.windows),
  };
}

function envTextOf(value: unknown): string {
  return Object.entries(objectOf(value))
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").join("\n") : "";
}

type MobileDevice = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
};

/**
 * Mobile Web Remote — start/stop a LAN HTTP/WebSocket host so a trusted phone
 * can drive CodeShell chat + approvals. Off by default; no public relay. The
 * pairing URL is one-time (10-min TTL) and must be opened on the phone.
 */
export function MobileRemoteSection() {
  const confirm = useConfirm();
  const [status, setStatus] = useState<{ running: boolean; url?: string }>({ running: false });
  const [pairingUrl, setPairingUrl] = useState<string | undefined>();
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>();
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [busy, setBusy] = useState(false);

  // Render the pairing URL as a QR code locally (no external service — the
  // token is a secret and must never leave the machine).
  useEffect(() => {
    if (!pairingUrl) {
      setQrDataUrl(undefined);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(pairingUrl, { width: 220, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [pairingUrl]);

  const refresh = useCallback(async () => {
    setStatus(await window.codeshell.mobileRemote.status());
    setDevices(await window.codeshell.mobileRemote.listDevices());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function start() {
    setBusy(true);
    try {
      const res = await window.codeshell.mobileRemote.start();
      setPairingUrl(res.pairingUrl);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await window.codeshell.mobileRemote.stop();
      setPairingUrl(undefined);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device: MobileDevice) {
    const ok = await confirm({
      title: "撤销设备",
      message: `撤销「${device.name}」后,该手机将无法重新连接。`,
      confirmLabel: "撤销",
      destructive: true,
    });
    if (!ok) return;
    await window.codeshell.mobileRemote.revokeDevice(device.id);
    await refresh();
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">手机遥控 (Mobile Remote)</h3>
      <p className="text-sm text-muted-foreground">
        在局域网启动一个手机网页遥控入口,供已配对的可信手机控制聊天与权限审批。默认关闭,不暴露公网。
      </p>
      <div className="flex gap-2 mt-3">
        <Button type="button" onClick={start} disabled={busy || status.running}>
          开启手机遥控
        </Button>
        <Button type="button" variant="outline" onClick={stop} disabled={busy || !status.running}>
          关闭
        </Button>
      </div>
      <p className="text-sm mt-2">
        {status.running ? `运行中:${status.url}` : "已关闭"}
      </p>
      {pairingUrl ? (
        <div className="mt-2">
          <p className="text-sm font-medium">配对二维码(10 分钟内有效,用手机扫码):</p>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="配对二维码"
              className="mt-2 rounded-md bg-white p-2"
              width={220}
              height={220}
            />
          ) : null}
          <p className="text-xs text-muted-foreground mt-2">或手动在手机浏览器打开:</p>
          <pre className="text-xs whitespace-pre-wrap break-all bg-muted rounded-md p-2 mt-1">
            {pairingUrl}
          </pre>
        </div>
      ) : null}
      <div className="mt-4 space-y-2">
        <h4 className="text-sm font-medium">可信设备</h4>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无可信设备。</p>
        ) : (
          devices.map((device) => (
            <div key={device.id} className="flex items-center justify-between text-sm">
              <span>
                {device.name}
                {device.revokedAt ? "(已撤销)" : ""}
              </span>
              {!device.revokedAt ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void revoke(device)}
                >
                  撤销
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
