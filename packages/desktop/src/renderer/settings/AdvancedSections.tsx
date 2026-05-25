import React, { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import type { GitBranches, GitStatus, WorktreeInfo } from "../../preload/types";
import { NO_REPO_KEY, type SessionIndex } from "../transcripts";
import { repoLabel, type Repo } from "../repos";
import { useConfirm, truncateTitle } from "../ui/ConfirmDialog";
import { Select } from "../ui/Select";

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
      await window.codeshell.updateSettings(
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
    await window.codeshell.updateSettings(scope, { hooks: next }, cwd);
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

export function ConnectionsSection({ scope, activeRepoPath }: ScopedProps) {
  const [provider, setProvider] = useState("serper");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const search = objectOf(s.search);
    setProvider(stringOf(search.provider) || "serper");
    setApiKey(stringOf(search.apiKey));
    setBaseUrl(stringOf(search.baseUrl));
  };
  useEffect(() => { void load(); }, [scope, activeRepoPath]);

  const save = async () => {
    setSaving(true);
    try {
      await window.codeshell.updateSettings(scope, { search: { provider, apiKey, baseUrl } }, cwd);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">连接</h3>
      <div className="settings-form-grid">
        <label className="settings-field">
          <span>搜索 Provider</span>
          <Select
            value={provider}
            onChange={setProvider}
            options={[
              { value: "serper", label: "Serper" },
              { value: "tavily", label: "Tavily" },
              { value: "searxng", label: "SearXNG" },
            ]}
          />
        </label>
        <label className="settings-field">
          <span>API Key</span>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="可留空" />
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="自定义服务地址" />
        </label>
      </div>
      <button className="approval-btn approve settings-save-btn" onClick={() => void save()} disabled={saving}>
        {saving ? "保存中..." : "保存连接"}
      </button>
    </section>
  );
}

export function GitSection({ activeRepoPath }: { activeRepoPath: string | null }) {
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!activeRepoPath) return;
    setError(null);
    try {
      const [b, s] = await Promise.all([
        window.codeshell.getGitBranches(activeRepoPath),
        window.codeshell.getGitStatus(activeRepoPath),
      ]);
      setBranches(b);
      setStatus(s);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  useEffect(() => { void refresh(); }, [activeRepoPath]);

  if (!activeRepoPath) return <EmptyProject label="Git" />;
  if (error) return <div className="view-error">{error}</div>;
  if (!branches) return <div className="view-loading">加载中...</div>;
  if (!branches.isRepo) return <div className="approvals-empty">当前项目不是 Git 仓库</div>;

  const switchTo = async (branch: string) => {
    setError(null);
    try {
      await window.codeshell.switchGitBranch(activeRepoPath, branch);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">Git</h3>
      <div className="settings-section-current">
        <span>当前分支：</span>
        <code>{branches.current ?? "(detached)"}</code>
        {status && <span>{status.clean ? "工作区干净" : `${status.entries.length} 个改动`}</span>}
      </div>
      <ul className="settings-list">
        {branches.branches.map((branch) => (
          <li className="settings-list-row" key={branch}>
            <strong>{branch}</strong>
            {branch === branches.current ? (
              <span className="model-active-badge">current</span>
            ) : (
              <button className="approval-btn deny" onClick={() => void switchTo(branch)}>
                切换
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
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
      await window.codeshell.updateSettings(
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

export function WorktreeSection({ activeRepoPath }: { activeRepoPath: string | null }) {
  const [items, setItems] = useState<WorktreeInfo[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    if (!activeRepoPath) return;
    setError(null);
    try {
      setItems(await window.codeshell.listWorktrees(activeRepoPath));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  useEffect(() => { void refresh(); }, [activeRepoPath]);

  if (!activeRepoPath) return <EmptyProject label="工作树" />;

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await window.codeshell.createWorktree(activeRepoPath, name);
      setName("");
      await refresh();
      await window.codeshell.revealInFinder(created.path);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">工作树</h3>
      <div className="settings-toolbar">
        <input
          className="sessions-filter"
          value={name}
          placeholder="新工作树名称"
          onChange={(e) => setName(e.target.value)}
        />
        <button className="approval-btn approve" disabled={creating || !name.trim()} onClick={() => void create()}>
          创建
        </button>
        <button className="approval-btn deny" onClick={() => void refresh()}>刷新</button>
      </div>
      {error && <div className="view-error">{error}</div>}
      {!items ? (
        <div className="view-loading">加载中...</div>
      ) : items.length === 0 ? (
        <div className="approvals-empty">暂无工作树</div>
      ) : (
        <ul className="settings-list">
          {items.map((item) => (
            <li className="settings-list-row" key={item.path}>
              <strong>{item.branch ?? "(detached)"}</strong>
              <code>{item.path}</code>
              {item.current && <span className="model-active-badge">main</span>}
              <button className="approval-btn deny" onClick={() => void window.codeshell.revealInFinder(item.path)}>
                打开
              </button>
            </li>
          ))}
        </ul>
      )}
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
      await window.codeshell.updateSettings(scope, { [settingKey]: { enabled: next } }, cwd);
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

function EmptyProject({ label }: { label: string }) {
  return <div className="approvals-empty">先选择一个项目，再配置「{label}」。</div>;
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
