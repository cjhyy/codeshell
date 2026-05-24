import React, { useEffect, useState } from "react";

interface ModelEntry {
  key: string;
  label: string;
  providerKey: string;
  maxContextTokens?: number;
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

/**
 * Active model picker.
 *
 * code-shell's settings.json layout is:
 *   {
 *     activeKey: "deepseek-v4-pro",
 *     providers: [{ key, kind, label, baseUrl, apiKey }],
 *     models:    [{ key, label, providerKey, model, maxContextTokens }]
 *   }
 *
 * The engine selects the active model by matching `activeKey` against
 * `models[].key`. We mirror that here: list models[] for the user to
 * pick from and write the chosen entry's key into `activeKey`. The
 * Composer's ModelPill writes the same field, so the two surfaces
 * stay in lockstep.
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
  const activeKey =
    typeof cur?.activeKey === "string" ? (cur.activeKey as string) :
    cur?.model && typeof (cur.model as Record<string, unknown>).name === "string"
      ? ((cur.model as Record<string, unknown>).name as string)
      : "";

  const setActive = async (entry: ModelEntry) => {
    setSaving(true);
    setError(null);
    try {
      await window.codeshell.updateSettings(scope, { activeKey: entry.key }, cwd);
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
        <code>{activeKey || "(none)"}</code>
      </div>
      {candidates.length === 0 ? (
        <div className="approvals-empty">
          settings.json 里还没声明 models。在 JSON 编辑器添加 models[] 数组。
        </div>
      ) : (
        <ul className="model-list">
          {candidates.map((m) => {
            const active = m.key === activeKey;
            return (
              <li
                key={m.key}
                className={`model-row${active ? " active" : ""}`}
                onClick={() => void setActive(m)}
              >
                <span className="model-provider">{m.providerKey}</span>
                <span className="model-name">{m.label}</span>
                {m.maxContextTokens && (
                  <span className="model-ctx">{formatTok(m.maxContextTokens)} ctx</span>
                )}
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

function candidatesFrom(s: Record<string, unknown>): ModelEntry[] {
  const models = s.models;
  if (!Array.isArray(models)) return [];
  const out: ModelEntry[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key :
                typeof obj.model === "string" ? obj.model : "";
    if (!key) continue;
    out.push({
      key,
      label: typeof obj.label === "string" ? obj.label :
             typeof obj.model === "string" ? obj.model : key,
      providerKey: typeof obj.providerKey === "string" ? obj.providerKey :
                   typeof obj.provider === "string" ? obj.provider : "",
      maxContextTokens: typeof obj.maxContextTokens === "number" ? obj.maxContextTokens : undefined,
    });
  }
  return out;
}

function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}
