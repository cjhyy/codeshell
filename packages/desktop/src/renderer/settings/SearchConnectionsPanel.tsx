import React, { useCallback, useMemo, useState } from "react";
import { useRefreshOnSettingsChange } from "./useSettingsResource";
import type { SearchProbeInput, SearchProbeResult } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { cacheGet, cacheSet } from "./settingsCache";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/ConfirmDialog";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";
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
  const { t } = useT();
  return (
    <section className="mb-6 flex flex-col gap-3">
      <header className="mb-3 flex flex-col gap-1">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
          {t("settingsX.searchConn.title")}
        </h3>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          {t("settingsX.searchConn.desc")}
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <CollapsibleGroup
          title={t("settingsX.searchConn.groupWebSearch")}
          subtitle={t("settingsX.searchConn.groupWebSearchSub")}
          defaultOpen
        >
          <SearchProvidersGrid scope={scope} activeRepoPath={activeRepoPath} />
        </CollapsibleGroup>

        <CollapsibleGroup
          title={t("settingsX.searchConn.groupImage")}
          subtitle={t("settingsX.searchConn.groupImageSub")}
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} tag="image" />
        </CollapsibleGroup>

        <CollapsibleGroup
          title={t("settingsX.searchConn.groupVideo")}
          subtitle={t("settingsX.searchConn.groupVideoSub")}
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} tag="video" />
        </CollapsibleGroup>

        <CollapsibleGroup
          title={t("settingsX.searchConn.groupAudio")}
          subtitle={t("settingsX.searchConn.groupAudioSub")}
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} tag="audio" />
        </CollapsibleGroup>
      </div>
    </section>
  );
}

type Provider = "serper" | "tavily" | "searxng";

interface ProviderMeta {
  id: Provider;
  displayName: string;
  /** i18n key for the provider's one-line description. */
  descKey: TranslationKey;
  needsKey: boolean;
  needsBaseUrl: boolean;
  signupUrl?: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "serper",
    displayName: "Google Web Search (Serper)",
    descKey: "settingsX.searchConn.descSerper",
    needsKey: true,
    needsBaseUrl: false,
    signupUrl: "https://serper.dev",
  },
  {
    id: "tavily",
    displayName: "Tavily AI Search",
    descKey: "settingsX.searchConn.descTavily",
    needsKey: true,
    needsBaseUrl: false,
    signupUrl: "https://tavily.com",
  },
  {
    id: "searxng",
    displayName: "SearXNG",
    descKey: "settingsX.searchConn.descSearxng",
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
  const { t } = useT();

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

  // Load on mount/scope switch + auto-refresh on config change (one place wires
  // the listeners — see useRefreshOnSettingsChange).
  useRefreshOnSettingsChange(() => void load(), [load]);

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
      toast({ message: t("settingsX.searchConn.toastSaved") });
    } catch (err) {
      console.error("saveProvider writeBack failed", err);
      toast({ message: t("settingsX.searchConn.toastSaveFailed"), variant: "error" });
      updateProvider(id, { saving: false });
    }
  };

  const clearProvider = async (id: Provider) => {
    const ok = await confirm({
      message: t("settingsX.searchConn.confirmClearMsg", {
        name: PROVIDERS.find((p) => p.id === id)?.displayName ?? id,
      }),
      detail: t("settingsX.searchConn.confirmClearDetail"),
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
      toast({ message: t("settingsX.searchConn.toastClearFailed"), variant: "error" });
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
        <div className="text-sm text-muted-foreground">{t("settingsX.searchConn.loading")}</div>
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
  const { t } = useT();
  const statusBadge = useMemo(() => {
    if (state.testing) return <Badge variant="info">{t("settingsX.searchConn.statusTesting")}</Badge>;
    if (state.probe?.status === "ok")
      return <Badge variant="success">{t("settingsX.searchConn.statusOk")}</Badge>;
    if (state.probe?.status === "error")
      return <Badge variant="error">{t("settingsX.searchConn.statusError")}</Badge>;
    if (state.probe?.status === "unconfigured" || !isConfigured) {
      return <Badge variant="secondary">{t("settingsX.searchConn.statusUnconfigured")}</Badge>;
    }
    return <Badge variant="secondary">{t("settingsX.searchConn.statusUntested")}</Badge>;
  }, [state.testing, state.probe, isConfigured, t]);

  return (
    <ConnCard isDefault={isDefault}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <strong className="text-sm font-medium text-foreground">{meta.displayName}</strong>
          {isDefault && <Badge variant="accent">{t("settingsX.searchConn.default")}</Badge>}
          {statusBadge}
        </div>
        {meta.signupUrl && (
          <Button
            variant="link"
            size="sm"
            className="h-auto shrink-0 p-0 text-xs"
            onClick={() => void window.codeshell.openExternal(meta.signupUrl!)}
          >
            {t("settingsX.searchConn.getKey")}
          </Button>
        )}
      </header>

      <p className="text-xs leading-relaxed text-muted-foreground">{t(meta.descKey)}</p>

      <div className="flex flex-col gap-2.5">
        {meta.needsKey && (
          <ConnField label="API Key" hint={t("settingsX.searchConn.apiKeyHint")}>
            <SecretKeyInput
              value={state.apiKey}
              show={state.showKey}
              onChange={(v) => onConfigChange({ apiKey: v })}
              onToggleShow={() => onUiChange({ showKey: !state.showKey })}
            />
          </ConnField>
        )}
        {meta.needsBaseUrl && (
          <ConnField label="Base URL" hint={t("settingsX.searchConn.baseUrlHint")}>
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
            {t("settingsX.searchConn.testSuccess")}
            {formatProbeTime(state.probe.lastProbedAt) && (
              <span className="font-normal text-muted-foreground">
                {" "}· {formatProbeTime(state.probe.lastProbedAt)}
              </span>
            )}
          </div>
          <ul className="m-0 list-disc pl-4 text-xs text-muted-foreground">
            {state.probe.sampleTitles.map((title) => (
              <li key={title}>{title}</li>
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
          title={
            isConfigured
              ? t("settingsX.searchConn.testConnTitle")
              : t("settingsX.searchConn.fillCredsFirst")
          }
        >
          {state.testing
            ? t("settingsX.searchConn.statusTesting")
            : t("settingsX.searchConn.testSearch")}
        </Button>
        <Button variant="solid" size="sm" onClick={onSave} disabled={state.saving || !state.dirty}>
          {state.saving ? t("settingsX.searchConn.saving") : t("settingsX.searchConn.save")}
        </Button>
        <ConnFooterRight>
          {isConfigured && !isDefault && (
            <Button variant="ghost" size="sm" onClick={onSetDefault}>
              {t("settingsX.searchConn.setDefault")}
            </Button>
          )}
          {isConfigured && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-status-err"
              onClick={onClear}
            >
              {t("settingsX.searchConn.clear")}
            </Button>
          )}
        </ConnFooterRight>
      </ConnCardFooter>
    </ConnCard>
  );
}
