import React, { useEffect, useState } from "react";

interface ProviderModel {
  provider: string;
  model: string;
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

/**
 * Lets the user pick the active model from whatever providers they
 * have configured. We don't have a network model-list RPC, so the
 * candidates come from the `providers[].models[]` arrays the user has
 * already declared in settings — exactly the source of truth code-shell
 * uses to dispatch LLM calls. Selecting one writes `model` and
 * `provider` at the top level (matching the engine's settings schema).
 */
export function ModelSection({ scope, activeRepoPath }: Props) {
  const [cur, setCur] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    try {
      const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
      setCur(s);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void load();
  }, [scope, activeRepoPath]);

  const candidates = candidatesFrom(cur ?? {});
  const activeProvider = typeof cur?.provider === "string" ? cur.provider : "";
  const activeModel = typeof cur?.model === "string" ? cur.model : "";

  const setActive = async (p: ProviderModel) => {
    setSaving(true);
    setError(null);
    try {
      await window.codeshell.updateSettings(
        scope,
        { provider: p.provider, model: p.model },
        cwd,
      );
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">Active model</h3>
      <div className="settings-section-current">
        <span className="settings-section-label">当前：</span>
        <code>
          {activeProvider || "(none)"} · {activeModel || "(none)"}
        </code>
      </div>
      {candidates.length === 0 ? (
        <div className="approvals-empty">
          settings.json 里还没声明任何 providers。先在 JSON 编辑里加上
          providers[].models[] 列表。
        </div>
      ) : (
        <ul className="model-list">
          {candidates.map((p) => {
            const active = p.provider === activeProvider && p.model === activeModel;
            return (
              <li
                key={`${p.provider}::${p.model}`}
                className={`model-row${active ? " active" : ""}`}
                onClick={() => void setActive(p)}
              >
                <span className="model-provider">{p.provider}</span>
                <span className="model-name">{p.model}</span>
                {active && <span className="model-active-badge">active</span>}
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="view-error">{error}</div>}
      {saving && <div className="approvals-empty">保存中…</div>}
    </section>
  );
}

function candidatesFrom(s: Record<string, unknown>): ProviderModel[] {
  const out: ProviderModel[] = [];
  const providers = s.providers;
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (!p || typeof p !== "object") continue;
      const obj = p as Record<string, unknown>;
      const provider = typeof obj.name === "string" ? obj.name : (typeof obj.kind === "string" ? obj.kind : "");
      const models = obj.models;
      if (Array.isArray(models)) {
        for (const m of models) {
          if (typeof m === "string") out.push({ provider, model: m });
          else if (m && typeof m === "object" && typeof (m as Record<string, unknown>).name === "string") {
            out.push({ provider, model: (m as Record<string, unknown>).name as string });
          }
        }
      }
    }
  }
  return out;
}
