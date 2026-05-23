import React, { useEffect, useState } from "react";

type Scope = "user" | "project";

interface Props {
  activeRepoPath: string | null;
}

export function SettingsView({ activeRepoPath }: Props) {
  const [scope, setScope] = useState<Scope>("user");
  const [draft, setDraft] = useState<string>("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    setLoaded(null);
    try {
      const cur = await window.codeshell.getSettings(
        scope,
        scope === "project" ? activeRepoPath ?? undefined : undefined,
      );
      const text = cur ? JSON.stringify(cur, null, 2) : "{}";
      setLoaded(text);
      setDraft(text);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, [scope, activeRepoPath]);

  const dirty = draft !== loaded;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch = JSON.parse(draft) as Record<string, unknown>;
      await window.codeshell.updateSettings(
        scope,
        patch,
        scope === "project" ? activeRepoPath ?? undefined : undefined,
      );
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
        <span className="settings-path">
          {scope === "project" && !activeRepoPath
            ? "(选一个项目)"
            : scope === "user"
              ? "~/.code-shell/settings.json"
              : `${activeRepoPath}/.code-shell/settings.json`}
        </span>
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
    </div>
  );
}
