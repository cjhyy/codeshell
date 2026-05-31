import React, { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { NO_REPO_KEY, type SessionIndex } from "../transcripts";
import { repoLabel, type Repo } from "../repos";
import { useConfirm, truncateTitle } from "../ui/ConfirmDialog";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Switch } from "@/components/ui/switch";
import { SearchConnectionsPanel } from "./SearchConnectionsPanel";
import {
  DEFAULT_GIT_PREFS,
  loadGitPrefs,
  saveGitPrefs,
  type GitPrefs,
} from "../gitPrefs";
import { writeSettings } from "../settingsBus";

interface ScopedProps {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

export function PersonalizationSection({ scope, activeRepoPath }: ScopedProps) {
  const [customPrompt, setCustomPrompt] = useState("");
  const [appendPrompt, setAppendPrompt] = useState("");
  const [fileName, setFileName] = useState("CODESHELL.md");
  const [scanDirs, setScanDirs] = useState("");
  const [compatFiles, setCompatFiles] = useState("CLAUDE.md\nAGENTS.md");
  const [saving, setSaving] = useState(false);

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const agent = objectOf(s.agent);
    const instructions = objectOf(s.instructions);
    setCustomPrompt(stringOf(agent.customSystemPrompt));
    setAppendPrompt(stringOf(agent.appendSystemPrompt));
    setFileName(stringOf(instructions.fileName) || "CODESHELL.md");
    setScanDirs(arrayText(instructions.scanDirs));
    setCompatFiles(arrayText(instructions.compatFileNames) || "CLAUDE.md\nAGENTS.md");
  };

  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  const save = async () => {
    setSaving(true);
    try {
      await writeSettings(
        scope,
        {
          agent: {
            customSystemPrompt: customPrompt,
            appendSystemPrompt: appendPrompt,
          },
          instructions: {
            fileName: fileName.trim() || "CODESHELL.md",
            scanDirs: lines(scanDirs),
            compatFileNames: lines(compatFiles),
          },
        },
        cwd,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">个性化指令</h3>
      <div className="settings-form-grid">
        <label className="settings-field">
          <span>覆盖系统提示</span>
          <textarea value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)} />
        </label>
        <label className="settings-field">
          <span>追加系统提示</span>
          <textarea value={appendPrompt} onChange={(e) => setAppendPrompt(e.target.value)} />
        </label>
        <label className="settings-field">
          <span>项目指令文件</span>
          <input value={fileName} onChange={(e) => setFileName(e.target.value)} />
        </label>
        <label className="settings-field">
          <span>额外扫描目录</span>
          <textarea value={scanDirs} onChange={(e) => setScanDirs(e.target.value)} />
        </label>
        <label className="settings-field">
          <span>兼容指令文件</span>
          <textarea value={compatFiles} onChange={(e) => setCompatFiles(e.target.value)} />
        </label>
      </div>
      <button className="approval-btn approve settings-save-btn" onClick={() => void save()} disabled={saving}>
        {saving ? "保存中..." : "保存个性化"}
      </button>
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

export function HooksSection({ scope, activeRepoPath }: ScopedProps) {
  const [hooks, setHooks] = useState<Array<Record<string, unknown>>>([]);
  const [draft, setDraft] = useState("{\n  \"event\": \"pre_tool_use\",\n  \"command\": \"echo '{}'\"\n}");
  const [error, setError] = useState<string | null>(null);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    setHooks(Array.isArray(s.hooks) ? (s.hooks as Array<Record<string, unknown>>) : []);
  };
  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  const persist = async (next: Array<Record<string, unknown>>) => {
    await writeSettings(scope, { hooks: next }, cwd);
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
    <section className="settings-section">
      <h3 className="settings-section-title">钩子</h3>
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
      <textarea className="settings-editor" style={{ minHeight: 120 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
      {error && <div className="view-error">{error}</div>}
      <button className="approval-btn approve settings-save-btn" onClick={() => void add()}>
        添加 hook
      </button>
    </section>
  );
}

export function ConnectionsSection(props: ScopedProps) {
  return <SearchConnectionsPanel {...props} />;
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

export function EnvironmentSection({ scope, activeRepoPath }: ScopedProps) {
  const [mode, setMode] = useState("auto");
  const [network, setNetwork] = useState("allow");
  const [writableRoots, setWritableRoots] = useState("");
  const [deniedReads, setDeniedReads] = useState("");
  const [saving, setSaving] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const sandbox = objectOf(s.sandbox);
    setMode(stringOf(sandbox.mode) || "auto");
    setNetwork(stringOf(sandbox.network) || "allow");
    setWritableRoots(arrayText(sandbox.writableRoots));
    setDeniedReads(arrayText(sandbox.deniedReads));
  };
  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  const save = async () => {
    setSaving(true);
    try {
      await writeSettings(
        scope,
        {
          sandbox: {
            mode,
            network,
            writableRoots: lines(writableRoots),
            deniedReads: lines(deniedReads),
          },
        },
        cwd,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">环境</h3>
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
        </label>
        <label className="settings-field">
          <span>Denied reads</span>
          <textarea value={deniedReads} onChange={(e) => setDeniedReads(e.target.value)} />
        </label>
      </div>
      <button className="approval-btn approve settings-save-btn" onClick={() => void save()} disabled={saving}>
        {saving ? "保存中..." : "保存环境"}
      </button>
    </section>
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

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").join("\n") : "";
}
