import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ImageProbeResult, CatalogEntry } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { cacheGet, cacheSet } from "./settingsCache";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SimpleSelect } from "@/components/ui/simple-select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/ConfirmDialog";
import {
  ConnCard,
  ConnCardGrid,
  ConnCardFooter,
  ConnFooterRight,
  ConnField,
  ConnProbeError,
  SecretKeyInput,
} from "./connUi";

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

/** Last-loaded snapshot per panel+scope (settingsCache) — seeds remounts so
 * tab switches don't flash the loading placeholder. */
interface GenSnapshot {
  catalog: CatalogEntry[];
  instances: Instance[];
  defaultId: string;
}

export function GenConnectionsPanel({ scope, activeRepoPath, config }: Props) {
  const { settingsKey, catalogTag, showTest, testFn, labels } = config;
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;
  const cacheKey = `gen:${settingsKey}:${scope}:${cwd ?? ""}`;
  const [seed] = useState(() => cacheGet<GenSnapshot>(cacheKey));
  const [catalog, setCatalog] = useState<CatalogEntry[]>(seed?.catalog ?? []);
  const [instances, setInstances] = useState<Instance[]>(seed?.instances ?? []);
  const [defaultId, setDefaultId] = useState<string>(seed?.defaultId ?? "");
  const [loaded, setLoaded] = useState(!!seed);
  const toast = useToast();
  const confirm = useConfirm();

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
    const nextDefault = dp && filtered.some((i) => i.id === dp) ? dp : filtered[0]?.id ?? "";
    setDefaultId(nextDefault);
    setLoaded(true);
    cacheSet(cacheKey, { catalog: cat, instances: filtered, defaultId: nextDefault } satisfies GenSnapshot);
  }, [scope, cwd, settingsKey, catalogTag, cacheKey]);

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

  /** One-step add (feedback: provider→model 分两步选很别扭): the add menu
   *  expands straight to the template's model presets, so picking a model
   *  creates a fully-configured card — no empty shell to configure after. */
  const addFromTemplate = (ce: CatalogEntry, model?: string) => {
    const taken = new Set(instances.map((i) => i.id));
    const id = uniqueId(ce.adapterKind, taken);
    const inst: Instance = {
      id,
      kind: ce.adapterKind,
      catalogId: ce.id,
      baseUrl: ce.defaultBaseUrl,
      apiKey: "",
      model: model ?? ce.defaultModel ?? "",
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
      toast({ message: "已保存" });
    } catch (err) {
      console.error(`${settingsKey} save failed`, err);
      toast({ message: "保存失败，请重试", variant: "error" });
      patch(id, { saving: false });
    }
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      message: `删除连接 #${id}？`,
      detail: "已保存的 API key 将一并移除。",
      destructive: true,
    });
    if (!ok) return;
    const next = instances.filter((i) => i.id !== id);
    let nextDefault = defaultId;
    if (defaultId === id) nextDefault = next[0]?.id ?? "";
    setInstances(next);
    setDefaultId(nextDefault);
    try {
      await writeBack(next, nextDefault);
    } catch (err) {
      console.error(`${settingsKey} remove failed`, err);
      toast({ message: "删除失败，已还原", variant: "error" });
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
    return (
      <ConnCardGrid>
        <div className="text-sm text-muted-foreground">加载中…</div>
      </ConnCardGrid>
    );
  }

  return (
    <ConnCardGrid>
      {instances.map((inst) => (
        <GenCard
          key={inst.id}
          inst={inst}
          entry={entryById(inst.catalogId)}
          isDefault={defaultId === inst.id}
          showTest={showTest}
          labels={labels}
          // Reuse-key candidates: other already-keyed instances of the SAME
          // provider kind. A key belongs to one provider account — offering
          // e.g. an OpenAI key to a Gemini card was wrong (it can never work);
          // cross-kind refs saved before this filter resolve to 未配置 so the
          // user re-enters a real key.
          reuseCandidates={instances.filter(
            (o) => o.id !== inst.id && o.kind === inst.kind && !!o.apiKey,
          )}
          onConfigChange={(p) => patch(inst.id, { ...p, dirty: true, probe: undefined })}
          onUiChange={(p) => patch(inst.id, p)}
          onSave={() => void save(inst.id)}
          onTest={() => void test(inst.id)}
          onRemove={() => void remove(inst.id)}
          onSetDefault={() => void setDefault(inst.id)}
        />
      ))}

      {templates.length > 0 && (
        <ConnCard className="items-start justify-center border-dashed bg-transparent">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="default">+ 添加模型</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {/* Providers with model presets expand to the models directly —
                  pick a model, get a ready card (one-step add). Providers
                  without presets stay a single click. */}
              {templates.map((ce) =>
                ce.modelPresets?.length ? (
                  <DropdownMenuSub key={ce.id}>
                    <DropdownMenuSubTrigger>{ce.displayName}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {ce.modelPresets.map((p) => (
                        <DropdownMenuItem
                          key={p.value}
                          onSelect={() => addFromTemplate(ce, p.value)}
                        >
                          {p.label ?? p.value}
                          {p.value === ce.defaultModel ? "（默认）" : ""}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : (
                  <DropdownMenuItem key={ce.id} onSelect={() => addFromTemplate(ce)}>
                    {ce.displayName}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <p className="text-xs leading-relaxed text-muted-foreground">
            选模型即建好卡片,填(或复用) key 即用。可添加多个。
          </p>
        </ConnCard>
      )}
    </ConnCardGrid>
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

  const statusBadge = useMemo(() => {
    if (showTest && inst.testing) return <Badge variant="info">生成测试中…</Badge>;
    if (showTest && inst.probe?.status === "ok") return <Badge variant="success">可用</Badge>;
    if (showTest && inst.probe?.status === "error") return <Badge variant="error">生成失败</Badge>;
    if (!isConfigured) return <Badge variant="secondary">未配置</Badge>;
    return <Badge variant="secondary">已配置</Badge>;
  }, [showTest, inst.testing, inst.probe, isConfigured]);

  return (
    <ConnCard isDefault={isDefault}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <strong className="text-sm font-medium text-foreground">{displayName}</strong>
          <span className="font-mono text-xs text-muted-foreground">#{inst.id}</span>
          {isDefault && <Badge variant="accent">默认</Badge>}
          {statusBadge}
        </div>
        {entry?.signupUrl && (
          <Button
            variant="link"
            size="sm"
            className="h-auto shrink-0 p-0 text-xs"
            onClick={() => void window.codeshell.openExternal(entry.signupUrl!)}
          >
            获取 key
          </Button>
        )}
      </header>

      {entry?.description && (
        <p className="text-xs leading-relaxed text-muted-foreground">{entry.description}</p>
      )}

      <div className="flex flex-col gap-2.5">
        <ConnField label="API Key" hint={labels.keyHint}>
          {/* 复用 toggle — only meaningful when there's another keyed instance. */}
          {reuseCandidates.length > 0 && (
            <div className="flex gap-1">
              <Button
                type="button"
                variant={!reusing ? "default" : "ghost"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => onConfigChange({ apiKeyRef: undefined })}
              >
                填新 key
              </Button>
              <Button
                type="button"
                variant={reusing ? "default" : "ghost"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => onConfigChange({ apiKeyRef: reuseCandidates[0].id, apiKey: "" })}
              >
                复用已有
              </Button>
            </div>
          )}
          {reusing ? (
            <SimpleSelect
              value={inst.apiKeyRef ?? ""}
              onChange={(v) => onConfigChange({ apiKeyRef: v, apiKey: "" })}
              placeholder="选择要复用的实例"
              options={reuseCandidates.map((o) => ({
                value: o.id,
                label: o.model ? `#${o.id} · ${o.model}` : `#${o.id}`,
              }))}
            />
          ) : (
            <SecretKeyInput
              value={inst.apiKey}
              show={inst.showKey}
              onChange={(v) => onConfigChange({ apiKey: v })}
              onToggleShow={() => onUiChange({ showKey: !inst.showKey })}
            />
          )}
        </ConnField>
        <ConnField label="Base URL">
          <Input
            value={inst.baseUrl}
            onChange={(e) => onConfigChange({ baseUrl: e.target.value.trim() })}
            placeholder={entry?.defaultBaseUrl}
            className="font-mono text-sm"
          />
        </ConnField>
        <ConnField label="默认模型">
          {presets?.length ? (
            <SimpleSelect
              value={inst.model}
              onChange={(v) => onConfigChange({ model: v })}
              placeholder="选择模型"
              options={presets.map((p) => ({ value: p.value, label: p.label ?? p.value }))}
            />
          ) : (
            <Input
              value={inst.model}
              onChange={(e) => onConfigChange({ model: e.target.value.trim() })}
              placeholder={entry ? entry.defaultModel : "未匹配到模板，手动填写模型 ID"}
              className="font-mono text-sm"
            />
          )}
        </ConnField>
      </div>

      {showTest && inst.probe?.status === "ok" && inst.probe.previewDataUrl && (
        <div className="flex flex-col gap-1">
          <div className="text-xs text-status-ok">测试生成成功</div>
          <img
            src={inst.probe.previewDataUrl}
            alt="probe preview"
            className="h-24 w-24 rounded-md border border-border object-cover"
          />
        </div>
      )}
      {showTest && inst.probe?.status === "error" && (
        <ConnProbeError message={inst.probe.errorMessage} />
      )}

      <ConnCardFooter>
        {showTest && (
          <Button
            variant="default"
            size="sm"
            onClick={onTest}
            disabled={inst.testing || !isConfigured}
            title={isConfigured ? labels.testTitleConfigured : "请先填写 API key"}
          >
            {inst.testing ? labels.testBusy : labels.testIdle}
          </Button>
        )}
        <Button variant="solid" size="sm" onClick={onSave} disabled={inst.saving || !inst.dirty}>
          {inst.saving ? "保存中…" : "保存"}
        </Button>
        <ConnFooterRight>
          {isConfigured && !isDefault && (
            <Button variant="ghost" size="sm" onClick={onSetDefault}>
              设为默认
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-status-err"
            onClick={onRemove}
          >
            删除
          </Button>
        </ConnFooterRight>
      </ConnCardFooter>
    </ConnCard>
  );
}
