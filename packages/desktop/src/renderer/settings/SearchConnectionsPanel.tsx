import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { SearchProbeInput, SearchProbeResult } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { cacheGet, cacheSet } from "./settingsCache";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/ConfirmDialog";
import { CollapsibleGroup } from "./CollapsibleGroup";
import { TextConnectionsPanel as UnifiedConnectionsPanel } from "./TextConnectionsPanel";
import {
  ConnCard,
  ConnCardGrid,
  ConnCardFooter,
  ConnFooterRight,
  ConnField,
  ConnProbeError,
  SecretKeyInput,
} from "./connUi";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

/**
 * 连接 page — one section holding several collapsible connection groups
 * (WebSearch, 图片生成, …). Each group folds independently; the WebSearch group
 * used to be un-collapsible, now all groups fold.
 */
export function ConnectionsPanel({ scope, activeRepoPath }: Props) {
  return (
    <section className="mb-6 flex flex-col gap-3">
      <header className="mb-3 flex flex-col gap-1">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">连接</h3>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          需要 key 的内置功能（WebSearch、图片生成、视频生成…）按功能分组放在这里；每组可折叠。
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <CollapsibleGroup
          title="WebSearch providers"
          subtitle="默认 provider 决定代理调用 WebSearch 时使用哪一个。"
          defaultOpen
        >
          <SearchProvidersGrid scope={scope} activeRepoPath={activeRepoPath} />
        </CollapsibleGroup>

        <CollapsibleGroup
          title="图片生成"
          subtitle="默认连接决定 GenerateImage 用哪一个；key 存在凭证里,多连接可共用。"
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} tag="image" title="图片模型" />
        </CollapsibleGroup>

        <CollapsibleGroup
          title="视频生成"
          subtitle="默认连接决定 GenerateVideo 用哪一个;key 存在凭证里,多连接可共用。"
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} tag="video" title="视频模型" />
        </CollapsibleGroup>
      </div>
    </section>
  );
}

type Provider = "serper" | "tavily" | "searxng";

interface ProviderMeta {
  id: Provider;
  displayName: string;
  description: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  signupUrl?: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "serper",
    displayName: "Google Web Search (Serper)",
    description: "Google 搜索结果代理，最常用。需要在 serper.dev 申请 API key。",
    needsKey: true,
    needsBaseUrl: false,
    signupUrl: "https://serper.dev",
  },
  {
    id: "tavily",
    displayName: "Tavily AI Search",
    description: "针对 AI 工作流优化的搜索接口，免费额度较友好。",
    needsKey: true,
    needsBaseUrl: false,
    signupUrl: "https://tavily.com",
  },
  {
    id: "searxng",
    displayName: "SearXNG（自建）",
    description: "开源元搜索引擎，自部署。提供 Base URL 即可，不需要 API key。",
    needsKey: false,
    needsBaseUrl: true,
  },
];

interface ProviderState {
  apiKey: string;
  baseUrl: string;
  probe?: SearchProbeResult;
  testing: boolean;
  saving: boolean;
  showKey: boolean;
  dirty: boolean;
}

const initialProviderState = (): ProviderState => ({
  apiKey: "",
  baseUrl: "",
  testing: false,
  saving: false,
  showKey: false,
  dirty: false,
});

function isProbeResult(value: unknown): value is SearchProbeResult {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.status === "ok" || rec.status === "error" || rec.status === "unconfigured") &&
    typeof rec.lastProbedAt === "string"
  );
}

function formatProbeTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Last-loaded snapshot per scope (settingsCache) — seeds remounts so tab
 * switches don't flash the loading placeholder. */
interface SearchSnapshot {
  defaultProvider: Provider;
  byProvider: Record<Provider, ProviderState>;
}

function SearchProvidersGrid({ scope, activeRepoPath }: Props) {
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;
  const cacheKey = `search:${scope}:${cwd ?? ""}`;
  const [seed] = useState(() => cacheGet<SearchSnapshot>(cacheKey));
  const [defaultProvider, setDefaultProvider] = useState<Provider>(seed?.defaultProvider ?? "serper");
  const [byProvider, setByProvider] = useState<Record<Provider, ProviderState>>(() =>
    seed?.byProvider ?? {
      serper: initialProviderState(),
      tavily: initialProviderState(),
      searxng: initialProviderState(),
    },
  );
  const [loaded, setLoaded] = useState(!!seed);
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const search = (s.search && typeof s.search === "object") ? (s.search as Record<string, unknown>) : {};
    // Legacy schema stored a single { provider, apiKey, baseUrl }. We migrate
    // by stamping its values onto the matching provider card; nothing is lost.
    const legacyProvider = typeof search.provider === "string" ? search.provider : "serper";
    const legacyKey = typeof search.apiKey === "string" ? search.apiKey : "";
    const legacyBaseUrl = typeof search.baseUrl === "string" ? search.baseUrl : "";

    const providersBag = (search.providers && typeof search.providers === "object")
      ? (search.providers as Record<string, Record<string, unknown>>)
      : {};

    const next: Record<Provider, ProviderState> = {
      serper: initialProviderState(),
      tavily: initialProviderState(),
      searxng: initialProviderState(),
    };
    for (const p of PROVIDERS) {
      const bag = providersBag[p.id] ?? {};
      next[p.id] = {
        ...next[p.id],
        apiKey: typeof bag.apiKey === "string" ? bag.apiKey : "",
        baseUrl: typeof bag.baseUrl === "string" ? bag.baseUrl : "",
        probe: isProbeResult(bag.lastProbe) ? bag.lastProbe : undefined,
      };
    }

    // Apply legacy fallback to whatever provider the legacy slot named.
    let nextDefault: Provider = "serper";
    if (legacyProvider === "serper" || legacyProvider === "tavily" || legacyProvider === "searxng") {
      const cur = next[legacyProvider];
      if (!cur.apiKey && legacyKey) cur.apiKey = legacyKey;
      if (!cur.baseUrl && legacyBaseUrl) cur.baseUrl = legacyBaseUrl;
      nextDefault = legacyProvider;
      setDefaultProvider(legacyProvider);
    }

    setByProvider(next);
    setLoaded(true);
    cacheSet(cacheKey, { defaultProvider: nextDefault, byProvider: next } satisfies SearchSnapshot);
  }, [scope, cwd, cacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateProvider = (id: Provider, patch: Partial<ProviderState>) => {
    setByProvider((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  };

  const writeBack = useCallback(
    async (nextProviders: Record<Provider, ProviderState>, nextDefault: Provider) => {
      const providersOut: Record<string, Record<string, unknown>> = {};
      for (const p of PROVIDERS) {
        const st = nextProviders[p.id];
        const bag: Record<string, unknown> = {};
        if (st.apiKey) bag.apiKey = st.apiKey;
        if (st.baseUrl) bag.baseUrl = st.baseUrl;
        if (st.probe) bag.lastProbe = st.probe;
        if (Object.keys(bag).length > 0) providersOut[p.id] = bag;
      }
      const active = nextProviders[nextDefault];
      await writeSettings(
        scope,
        {
          search: {
            provider: nextDefault,
            apiKey: active.apiKey || undefined,
            baseUrl: active.baseUrl || undefined,
            providers: providersOut,
          },
        },
        cwd,
      );
    },
    [scope, cwd],
  );

  const saveProvider = async (id: Provider) => {
    updateProvider(id, { saving: true });
    try {
      const next = {
        ...byProvider,
        [id]: { ...byProvider[id], saving: false, dirty: false },
      };
      await writeBack(next, defaultProvider);
      setByProvider(next);
      toast({ message: "已保存" });
    } catch (err) {
      console.error("saveProvider writeBack failed", err);
      toast({ message: "保存失败，请重试", variant: "error" });
      updateProvider(id, { saving: false });
    }
  };

  const clearProvider = async (id: Provider) => {
    const ok = await confirm({
      message: `清除「${PROVIDERS.find((p) => p.id === id)?.displayName ?? id}」的凭证？`,
      detail: "已保存的 API key / Base URL 将被移除。",
      destructive: true,
    });
    if (!ok) return;
    const next = {
      ...byProvider,
      [id]: { ...initialProviderState() },
    };
    setByProvider(next);
    try {
      await writeBack(next, defaultProvider);
    } catch (err) {
      // Don't leave the UI cleared while the persisted settings still hold the
      // old provider — log and reload from disk to resync.
      console.error("clearProvider writeBack failed", err);
      toast({ message: "清除失败，已还原", variant: "error" });
      void load();
    }
  };

  const testProvider = async (id: Provider) => {
    const st = byProvider[id];
    updateProvider(id, { testing: true });
    const input: SearchProbeInput = {
      provider: id,
      apiKey: st.apiKey || undefined,
      baseUrl: st.baseUrl || undefined,
    };
    try {
      const result = await window.codeshell.probeSearch(input);
      const next = {
        ...byProvider,
        [id]: { ...byProvider[id], probe: result, testing: false },
      };
      setByProvider(next);
      if (result.status === "ok") await writeBack(next, defaultProvider);
    } catch (e) {
      updateProvider(id, {
        probe: {
          status: "error",
          errorMessage: String(e instanceof Error ? e.message : e),
          lastProbedAt: new Date().toISOString(),
        },
        testing: false,
      });
    }
  };

  const setDefault = async (id: Provider) => {
    setDefaultProvider(id);
    await writeBack(byProvider, id);
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
      {PROVIDERS.map((meta) => {
        const st = byProvider[meta.id];
        const isDefault = defaultProvider === meta.id;
        const isConfigured = meta.needsKey ? !!st.apiKey : !!st.baseUrl;
        return (
          <ConnectionCard
            key={meta.id}
            meta={meta}
            state={st}
            isDefault={isDefault}
            isConfigured={isConfigured}
            onConfigChange={(patch) => updateProvider(meta.id, { ...patch, dirty: true, probe: undefined })}
            onUiChange={(patch) => updateProvider(meta.id, patch)}
            onSave={() => void saveProvider(meta.id)}
            onTest={() => void testProvider(meta.id)}
            onClear={() => void clearProvider(meta.id)}
            onSetDefault={() => void setDefault(meta.id)}
          />
        );
      })}
    </ConnCardGrid>
  );
}

interface CardProps {
  meta: ProviderMeta;
  state: ProviderState;
  isDefault: boolean;
  isConfigured: boolean;
  onConfigChange: (patch: Partial<ProviderState>) => void;
  onUiChange: (patch: Partial<ProviderState>) => void;
  onSave: () => void;
  onTest: () => void;
  onClear: () => void;
  onSetDefault: () => void;
}

function ConnectionCard({
  meta,
  state,
  isDefault,
  isConfigured,
  onConfigChange,
  onUiChange,
  onSave,
  onTest,
  onClear,
  onSetDefault,
}: CardProps) {
  const statusBadge = useMemo(() => {
    if (state.testing) return <Badge variant="info">测试中…</Badge>;
    if (state.probe?.status === "ok") return <Badge variant="success">可用</Badge>;
    if (state.probe?.status === "error") return <Badge variant="error">连接失败</Badge>;
    if (state.probe?.status === "unconfigured" || !isConfigured) {
      return <Badge variant="secondary">未配置</Badge>;
    }
    return <Badge variant="secondary">未测试</Badge>;
  }, [state.testing, state.probe, isConfigured]);

  return (
    <ConnCard isDefault={isDefault}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <strong className="text-sm font-medium text-foreground">{meta.displayName}</strong>
          {isDefault && <Badge variant="accent">默认</Badge>}
          {statusBadge}
        </div>
        {meta.signupUrl && (
          <Button
            variant="link"
            size="sm"
            className="h-auto shrink-0 p-0 text-xs"
            onClick={() => void window.codeshell.openExternal(meta.signupUrl!)}
          >
            获取 key
          </Button>
        )}
      </header>

      <p className="text-xs leading-relaxed text-muted-foreground">{meta.description}</p>

      <div className="flex flex-col gap-2.5">
        {meta.needsKey && (
          <ConnField label="API Key" hint="保存于 ~/.code-shell/settings.json，按 scope 隔离。">
            <SecretKeyInput
              value={state.apiKey}
              show={state.showKey}
              onChange={(v) => onConfigChange({ apiKey: v })}
              onToggleShow={() => onUiChange({ showKey: !state.showKey })}
            />
          </ConnField>
        )}
        {meta.needsBaseUrl && (
          <ConnField label="Base URL" hint="自部署 SearXNG 实例地址。">
            <Input
              value={state.baseUrl}
              onChange={(e) => onConfigChange({ baseUrl: e.target.value.trim() })}
              placeholder="https://searxng.example.com"
              className="font-mono text-sm"
            />
          </ConnField>
        )}
      </div>

      {state.probe?.status === "ok" && state.probe.sampleTitles?.length && (
        <div className="rounded-md border border-status-ok/25 bg-status-ok/5 px-2.5 py-2 text-sm">
          <div className="mb-1 font-medium text-status-ok">
            测试成功
            {formatProbeTime(state.probe.lastProbedAt) && (
              <span className="font-normal text-muted-foreground">
                {" "}· {formatProbeTime(state.probe.lastProbedAt)}
              </span>
            )}
          </div>
          <ul className="m-0 list-disc pl-4 text-xs text-muted-foreground">
            {state.probe.sampleTitles.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {state.probe?.status === "error" && <ConnProbeError message={state.probe.errorMessage} />}

      <ConnCardFooter>
        <Button
          variant="default"
          size="sm"
          onClick={onTest}
          disabled={state.testing || !isConfigured}
          title={isConfigured ? "测试搜索连接" : "请先填写凭证"}
        >
          {state.testing ? "测试中…" : "测试搜索"}
        </Button>
        <Button variant="solid" size="sm" onClick={onSave} disabled={state.saving || !state.dirty}>
          {state.saving ? "保存中…" : "保存"}
        </Button>
        <ConnFooterRight>
          {isConfigured && !isDefault && (
            <Button variant="ghost" size="sm" onClick={onSetDefault}>
              设为默认
            </Button>
          )}
          {isConfigured && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-status-err"
              onClick={onClear}
            >
              清除
            </Button>
          )}
        </ConnFooterRight>
      </ConnCardFooter>
    </ConnCard>
  );
}
