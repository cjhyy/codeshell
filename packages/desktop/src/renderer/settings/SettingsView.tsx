import React, { useEffect, useState } from "react";
import { ModelSection } from "./ModelSection";
import { PermissionSection } from "./PermissionSection";
import { McpSection } from "./McpSection";

type Scope = "user" | "project";
type Tab = "model" | "permission" | "mcp" | "json";

interface Props {
  activeRepoPath: string | null;
}

export function SettingsView({ activeRepoPath }: Props) {
  const [scope, setScope] = useState<Scope>("user");
  const [tab, setTab] = useState<Tab>("model");
  const [draft, setDraft] = useState<string>("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const refresh = async () => {
    setError(null);
    setLoaded(null);
    try {
      const cur = await window.codeshell.getSettings(scope, cwd);
      const text = cur ? JSON.stringify(cur, null, 2) : "{}";
      setLoaded(text);
      setDraft(text);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    if (tab === "json") void refresh();
  }, [scope, activeRepoPath, tab]);

  const dirty = draft !== loaded;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch = JSON.parse(draft) as Record<string, unknown>;
      await window.codeshell.updateSettings(scope, patch, cwd);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-view">
      <div className="settings-toolbar">
        <div className="settings-scope">
          <button
            className={`logs-bucket${scope === "user" ? " active" : ""}`}
            onClick={() => setScope("user")}
          >
            user
          </button>
          <button
            className={`logs-bucket${scope === "project" ? " active" : ""}`}
            disabled={!activeRepoPath}
            title={activeRepoPath ? activeRepoPath : "先在左侧选一个 repo"}
            onClick={() => setScope("project")}
          >
            project
          </button>
        </div>
        <div className="settings-scope">
          {(["model", "permission", "mcp", "json"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`logs-bucket${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {tabLabel(t)}
            </button>
          ))}
        </div>
        <span className="settings-path">
          {scope === "project" && !activeRepoPath
            ? "(选一个项目)"
            : scope === "user"
              ? "~/.code-shell/settings.json"
              : `${activeRepoPath}/.code-shell/settings.json`}
        </span>
      </div>

      {tab === "model" && <ModelSection scope={scope} activeRepoPath={activeRepoPath} />}
      {tab === "permission" && <PermissionSection scope={scope} activeRepoPath={activeRepoPath} />}
      {tab === "mcp" && <McpSection scope={scope} activeRepoPath={activeRepoPath} />}
      {tab === "json" && (
        <>
          <div className="settings-toolbar">
            <button className="approval-btn deny" onClick={() => void refresh()} disabled={saving}>
              Reload
            </button>
            <button
              className="approval-btn approve"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "Save"}
            </button>
          </div>
          {error && <div className="view-error">{error}</div>}
          <textarea
            className="settings-editor"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </>
      )}
    </div>
  );
}

function tabLabel(t: Tab): string {
  switch (t) {
    case "model": return "模型";
    case "permission": return "权限";
    case "mcp": return "MCP";
    case "json": return "JSON";
  }
}
