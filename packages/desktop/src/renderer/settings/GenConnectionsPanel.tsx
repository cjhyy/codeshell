import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ImageProbeResult, CatalogEntry } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/simple-select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

/** Probe result shape (reused from image probe; video has no probe → unused). */
export type ProbeResult = ImageProbeResult;

export interface GenPanelConfig {
  /** settings.<settingsKey>.providers[] */
  settingsKey: "imageGen" | "videoGen";
  /** Which catalog tag this panel renders (templates filtered by it). */
  catalogTag: "image" | "video";
  /** Render the "test" button + probe UI (image) vs not (video). */
  showTest: boolean;
  /** Probe function used when showTest; required if showTest. */
  testFn?: (input: { kind: string; apiKey?: string; baseUrl?: string; model?: string }) => Promise<ProbeResult>;
  labels: {
    testIdle: string;
    testBusy: string;
    testTitleConfigured: string;
    keyHint: string;
  };
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
  config: GenPanelConfig;
}

/** A configured instance (settings.<key>.providers[] entry) + UI-only fields. */
interface Instance {
  id: string;
  kind: string;
  catalogId?: string;
  baseUrl: string;
  apiKey: string;
  /** When set, reuse this other instance's key (apiKey left empty). */
  apiKeyRef?: string;
  model: string;
  // —— UI-only ——
  probe?: ProbeResult;
  testing: boolean;
  saving: boolean;
  showKey: boolean;
  dirty: boolean;
}

function isProbeResult(value: unknown): value is ProbeResult {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.status === "ok" || rec.status === "error" || rec.status === "unconfigured") &&
    typeof rec.lastProbedAt === "string"
  );
}

/** Generate a unique instance id from a catalog adapterKind (kind, kind-2, …). */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
}

export function GenConnectionsPanel({ scope, activeRepoPath, config }: Props) {
  const { settingsKey, catalogTag, showTest, testFn, labels } = config;
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [defaultId, setDefaultId] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  /** Catalog entries that belong to this panel's tag (the [+ 添加] menu). */
  const templates = useMemo(() => catalog.filter((e) => e.tag === catalogTag), [catalog, catalogTag]);
  const entryById = useCallback(
    (id?: string): CatalogEntry | undefined => (id ? catalog.find((e) => e.id === id) : undefined),
    [catalog],
  );

  const load = useCallback(async () => {
    const cat = (await window.codeshell.getModelCatalog().catch(() => [])) as CatalogEntry[];
    setCatalog(cat);

    const s = ((await window.codeshell.getSettings(scope, cwd)) ?? {}) as Record<string, unknown>;
    const gen = s[settingsKey] && typeof s[settingsKey] === "object" ? (s[settingsKey] as Record<string, unknown>) : {};
    const list = Array.isArray(gen.providers) ? (gen.providers as Array<Record<string, unknown>>) : [];

    const next: Instance[] = list.map((p) => {
      const catId = typeof p.catalogId === "string" ? p.catalogId : undefined;
      const ce = catId ? cat.find((e) => e.id === catId) : cat.find((e) => e.adapterKind === p.kind && e.tag === catalogTag);
      return {
        id: String(p.id ?? p.kind ?? ""),
        kind: String(p.kind ?? ce?.adapterKind ?? ""),
        // Legacy entries (pre-Catalog v1) have no catalogId — adopt the
        // kind+tag fallback match so the card resolves its template (model
        // presets etc.) and the next writeBack persists the reconciliation.
        catalogId: catId ?? ce?.id,
        baseUrl: typeof p.baseUrl === "string" && p.baseUrl ? p.baseUrl : ce?.defaultBaseUrl ?? "",
        apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
        apiKeyRef: typeof p.apiKeyRef === "string" && p.apiKeyRef ? p.apiKeyRef : undefined,
        model: typeof p.defaultModel === "string" && p.defaultModel ? p.defaultModel : ce?.defaultModel ?? "",
        probe: isProbeResult(p.lastProbe) ? p.lastProbe : undefined,
        testing: false,
        saving: false,
        showKey: false,
        dirty: false,
      };
    });
    // Only keep instances whose adapter belongs to this panel's tag.
    const filtered = next.filter(
      (i) => i.catalogId === undefined || entryByTagOk(cat, i.catalogId, catalogTag),
    );
    setInstances(filtered);
    const dp = typeof gen.defaultProvider === "string" ? gen.defaultProvider : undefined;
    if (dp && filtered.some((i) => i.id === dp)) setDefaultId(dp);
    else setDefaultId(filtered[0]?.id ?? "");
    setLoaded(true);
  }, [scope, cwd, settingsKey, catalogTag]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (id: string, p: Partial<Instance>) =>
    setInstances((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i)));

  /** Persist all configured instances (those with a usable key, direct or referenced). */
  const writeBack = useCallback(
    async (list: Instance[], nextDefault: string) => {
      const hasKey = (i: Instance): boolean =>
        !!i.apiKey || (!!i.apiKeyRef && !!list.find((o) => o.id === i.apiKeyRef)?.apiKey);
      const out = list
        .filter(hasKey)
        .map((i) => {
          const ce = entryById(i.catalogId);
          const entry: Record<string, unknown> = {
            id: i.id,
            kind: i.kind,
            baseUrl: i.baseUrl || ce?.defaultBaseUrl || "",
            defaultModel: i.model || ce?.defaultModel || "",
          };
          if (i.catalogId) entry.catalogId = i.catalogId;
          if (i.apiKeyRef) entry.apiKeyRef = i.apiKeyRef;
          else entry.apiKey = i.apiKey;
          if (i.probe) entry.lastProbe = i.probe;
          return entry;
        });
      await writeSettings(scope, { [settingsKey]: { defaultProvider: nextDefault, providers: out } }, cwd);
    },
    [scope, cwd, settingsKey, entryById],
  );

  const addFromTemplate = (ce: CatalogEntry) => {
    const taken = new Set(instances.map((i) => i.id));
    const id = uniqueId(ce.adapterKind, taken);
    const inst: Instance = {
      id,
      kind: ce.adapterKind,
      catalogId: ce.id,
      baseUrl: ce.defaultBaseUrl,
      apiKey: "",
      model: ce.defaultModel ?? "",
      testing: false,
      saving: false,
      showKey: false,
      dirty: true,
    };
    setInstances((cur) => [...cur, inst]);
    if (!defaultId) setDefaultId(id);
  };

  const save = async (id: string) => {
    patch(id, { saving: true });
    try {
      const next = instances.map((i) => (i.id === id ? { ...i, saving: false, dirty: false } : i));
      await writeBack(next, defaultId || id);
      setInstances(next);
      if (!defaultId) setDefaultId(id);
    } catch (err) {
      console.error(`${settingsKey} save failed`, err);
      patch(id, { saving: false });
    }
  };

  const remove = async (id: string) => {
    const next = instances.filter((i) => i.id !== id);
    let nextDefault = defaultId;
    if (defaultId === id) nextDefault = next[0]?.id ?? "";
    setInstances(next);
    setDefaultId(nextDefault);
    try {
      await writeBack(next, nextDefault);
    } catch (err) {
      console.error(`${settingsKey} remove failed`, err);
      void load();
    }
  };

  const test = async (id: string) => {
    if (!showTest || !testFn) return;
    const inst = instances.find((i) => i.id === id);
    if (!inst) return;
    const effKey = inst.apiKey || (inst.apiKeyRef ? instances.find((o) => o.id === inst.apiKeyRef)?.apiKey : undefined);
    patch(id, { testing: true });
    try {
      const result = await testFn({ kind: inst.kind, apiKey: effKey || undefined, baseUrl: inst.baseUrl || undefined, model: inst.model || undefined });
      const next = instances.map((i) => (i.id === id ? { ...i, probe: result, testing: false } : i));
      setInstances(next);
      if (result.status === "ok") await writeBack(next, defaultId || id);
    } catch (e) {
      patch(id, {
        probe: { status: "error", errorMessage: String(e instanceof Error ? e.message : e), lastProbedAt: new Date().toISOString() },
        testing: false,
      });
    }
  };

  const setDefault = async (id: string) => {
    setDefaultId(id);
    await writeBack(instances, id);
  };

  if (!loaded) {
    return <div className="connections-card-grid"><div className="view-loading">加载中…</div></div>;
  }

  return (
    <div className="connections-card-grid">
      {instances.map((inst) => (
        <GenCard
          key={inst.id}
          inst={inst}
          entry={entryById(inst.catalogId)}
          isDefault={defaultId === inst.id}
          showTest={showTest}
          labels={labels}
          // Other already-keyed instances in this panel — reuse-key candidates.
          reuseCandidates={instances.filter((o) => o.id !== inst.id && !!o.apiKey)}
          onConfigChange={(p) => patch(inst.id, { ...p, dirty: true, probe: undefined })}
          onUiChange={(p) => patch(inst.id, p)}
          onSave={() => void save(inst.id)}
          onTest={() => void test(inst.id)}
          onRemove={() => void remove(inst.id)}
          onSetDefault={() => void setDefault(inst.id)}
        />
      ))}

      {templates.length > 0 && (
        <article className="conn-card conn-card-add">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default">+ 添加模型</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {templates.map((ce) => (
                <DropdownMenuItem key={ce.id} onSelect={() => addFromTemplate(ce)}>
                  {ce.displayName}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <p className="conn-card-desc">从目录挑一个,填(或复用) key 即用。可添加多个。</p>
        </article>
      )}
    </div>
  );
}

/** True when catalogId resolves to an entry whose tag matches this panel. */
function entryByTagOk(catalog: CatalogEntry[], catalogId: string, tag: "image" | "video"): boolean {
  const e = catalog.find((c) => c.id === catalogId);
  return !e || e.tag === tag; // unknown id → keep (don't silently drop user data)
}

interface CardProps {
  inst: Instance;
  entry?: CatalogEntry;
  isDefault: boolean;
  showTest: boolean;
  labels: GenPanelConfig["labels"];
  reuseCandidates: Instance[];
  onConfigChange: (patch: Partial<Instance>) => void;
  onUiChange: (patch: Partial<Instance>) => void;
  onSave: () => void;
  onTest: () => void;
  onRemove: () => void;
  onSetDefault: () => void;
}

function GenCard({
  inst, entry, isDefault, showTest, labels, reuseCandidates,
  onConfigChange, onUiChange, onSave, onTest, onRemove, onSetDefault,
}: CardProps) {
  const reusing = !!inst.apiKeyRef;
  const refOk = reusing && reuseCandidates.some((o) => o.id === inst.apiKeyRef);
  const isConfigured = !!inst.apiKey || refOk;
  const displayName = entry?.displayName ?? inst.kind;
  const presets = entry?.modelPresets;

  const statusPill = useMemo(() => {
    if (showTest && inst.testing) return <span className="conn-pill probing">生成测试中…</span>;
    if (showTest && inst.probe?.status === "ok") return <span className="conn-pill ok">可用</span>;
    if (showTest && inst.probe?.status === "error") return <span className="conn-pill err">生成失败</span>;
    if (!isConfigured) return <span className="conn-pill unknown">未配置</span>;
    return <span className="conn-pill unknown">已配置</span>;
  }, [showTest, inst.testing, inst.probe, isConfigured]);

  return (
    <article className={`conn-card${isDefault ? " is-default" : ""}`}>
      <header className="conn-card-head">
        <div className="conn-card-title">
          <strong>{displayName}</strong>
          <span className="conn-instance-id">#{inst.id}</span>
          {isDefault && <span className="conn-default-pill">默认</span>}
          {statusPill}
        </div>
        <div className="conn-card-head-actions">
          {entry?.signupUrl && (
            <button className="conn-link-btn" onClick={() => void window.codeshell.openExternal(entry.signupUrl!)}>
              获取 key
            </button>
          )}
        </div>
      </header>

      {entry?.description && <p className="conn-card-desc">{entry.description}</p>}

      <div className="settings-form-grid">
        <label className="settings-field">
          <span>API Key</span>
          {/* 复用 toggle — only meaningful when there's another keyed instance. */}
          {reuseCandidates.length > 0 && (
            <div className="conn-key-mode">
              <button
                type="button"
                className={`conn-link-btn${!reusing ? " is-active" : ""}`}
                onClick={() => onConfigChange({ apiKeyRef: undefined })}
              >
                填新 key
              </button>
              <button
                type="button"
                className={`conn-link-btn${reusing ? " is-active" : ""}`}
                onClick={() => onConfigChange({ apiKeyRef: reuseCandidates[0].id, apiKey: "" })}
              >
                复用已有
              </button>
            </div>
          )}
          {reusing ? (
            <SimpleSelect
              value={inst.apiKeyRef ?? ""}
              onChange={(v) => onConfigChange({ apiKeyRef: v, apiKey: "" })}
              placeholder="选择要复用的实例"
              options={reuseCandidates.map((o) => ({ value: o.id, label: `#${o.id}` }))}
            />
          ) : (
            <div className="conn-secret-row">
              <input
                type={inst.showKey ? "text" : "password"}
                value={inst.apiKey}
                onChange={(e) => onConfigChange({ apiKey: e.target.value.trim() })}
                placeholder="粘贴 API key"
              />
              <button className="conn-secret-toggle" type="button" onClick={() => onUiChange({ showKey: !inst.showKey })}>
                {inst.showKey ? "隐藏" : "显示"}
              </button>
            </div>
          )}
          <span className="conn-field-hint">{labels.keyHint}</span>
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input
            value={inst.baseUrl}
            onChange={(e) => onConfigChange({ baseUrl: e.target.value.trim() })}
            placeholder={entry?.defaultBaseUrl}
          />
        </label>
        <label className="settings-field">
          <span>默认模型</span>
          {presets?.length ? (
            <SimpleSelect
              value={inst.model}
              onChange={(v) => onConfigChange({ model: v })}
              placeholder="选择模型"
              options={presets.map((p) => ({ value: p.value, label: p.label ?? p.value }))}
            />
          ) : (
            <input
              value={inst.model}
              onChange={(e) => onConfigChange({ model: e.target.value.trim() })}
              placeholder={entry ? entry.defaultModel : "未匹配到模板，手动填写模型 ID"}
            />
          )}
        </label>
      </div>

      {showTest && inst.probe?.status === "ok" && inst.probe.previewDataUrl && (
        <div className="conn-probe-image">
          <div className="conn-probe-title">测试生成成功</div>
          <img src={inst.probe.previewDataUrl} alt="probe preview" />
        </div>
      )}
      {showTest && inst.probe?.status === "error" && <div className="conn-probe-err">{inst.probe.errorMessage}</div>}

      <footer className="conn-card-footer">
        {showTest && (
          <Button variant="default" onClick={onTest} disabled={inst.testing || !isConfigured} title={isConfigured ? labels.testTitleConfigured : "请先填写 API key"}>
            {inst.testing ? labels.testBusy : labels.testIdle}
          </Button>
        )}
        <Button variant="solid" onClick={onSave} disabled={inst.saving || !inst.dirty}>
          {inst.saving ? "保存中…" : "保存"}
        </Button>
        {isConfigured && !isDefault && (
          <Button variant="default" onClick={onSetDefault}>
            设为默认
          </Button>
        )}
        <Button variant="destructive" onClick={onRemove}>
          删除
        </Button>
      </footer>
    </article>
  );
}
