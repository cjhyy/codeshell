import React, { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";
import {
  useSearchConnections,
  type SearchProvider as Provider,
  type SearchProviderState as ProviderState,
} from "./useSearchConnections";
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
  activeProjectPath: string | null;
}

/**
 * 连接 page — one section holding several collapsible connection groups
 * (WebSearch, 图片生成, …). Each group folds independently; the WebSearch group
 * used to be un-collapsible, now all groups fold.
 */
export function ConnectionsPanel({ scope, activeProjectPath }: Props) {
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
          <SearchProvidersGrid
            key={`${scope}:${activeProjectPath ?? ""}`}
            scope={scope}
            activeProjectPath={activeProjectPath}
          />
        </CollapsibleGroup>

        <CollapsibleGroup
          title={t("settingsX.searchConn.groupImage")}
          subtitle={t("settingsX.searchConn.groupImageSub")}
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel
            scope={scope}
            activeProjectPath={activeProjectPath}
            tag="image"
          />
        </CollapsibleGroup>

        <CollapsibleGroup
          title={t("settingsX.searchConn.groupVideo")}
          subtitle={t("settingsX.searchConn.groupVideoSub")}
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel
            scope={scope}
            activeProjectPath={activeProjectPath}
            tag="video"
          />
        </CollapsibleGroup>

        <CollapsibleGroup
          title={t("settingsX.searchConn.groupSpeech")}
          subtitle={t("settingsX.searchConn.groupSpeechSub")}
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel
            scope={scope}
            activeProjectPath={activeProjectPath}
            tag="speech"
          />
        </CollapsibleGroup>

        <CollapsibleGroup
          title={t("settingsX.searchConn.groupAudio")}
          subtitle={t("settingsX.searchConn.groupAudioSub")}
          defaultOpen={false}
        >
          <UnifiedConnectionsPanel
            scope={scope}
            activeProjectPath={activeProjectPath}
            tag="audio"
          />
        </CollapsibleGroup>
      </div>
    </section>
  );
}

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

function SearchProvidersGrid({ scope, activeProjectPath }: Props) {
  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;
  const { t } = useT();
  const {
    byProvider,
    defaultProvider,
    loaded,
    loading,
    loadFailed,
    busy,
    panelRef,
    headingRef,
    load,
    patch,
    save,
    test,
    clear,
    setDefault,
  } = useSearchConnections(scope, projectPath);
  const disabled = Boolean(busy) || loading || loadFailed;
  const titleId = React.useId();
  return (
    <section
      ref={panelRef}
      aria-busy={Boolean(busy) || loading}
      aria-labelledby={titleId}
      className="relative min-w-0"
    >
      <h4 ref={headingRef} id={titleId} tabIndex={-1} className="sr-only">
        {t("settingsX.searchConn.groupWebSearch")}
      </h4>
      {loadFailed && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-status-err/25 bg-status-err/5 p-3"
        >
          <p className="min-w-0 flex-1 basis-48 text-sm text-status-err">
            {t(loaded ? "settingsX.searchConn.refreshFailed" : "settingsX.searchConn.readFailed")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
          >
            {t("settingsX.searchConn.retryRead")}
          </Button>
        </div>
      )}
      <ConnCardGrid>
        {!loaded ? (
          <div role="status" className="text-sm text-muted-foreground">
            {loading ? t("settingsX.searchConn.loading") : null}
          </div>
        ) : (
          PROVIDERS.map((meta) => {
            const state = byProvider[meta.id];
            return (
              <ConnectionCard
                key={meta.id}
                meta={meta}
                state={state}
                isDefault={defaultProvider === meta.id}
                isConfigured={meta.needsKey ? Boolean(state.apiKey) : Boolean(state.baseUrl)}
                disabled={disabled}
                testing={busy?.action === "test" && busy.id === meta.id}
                saving={busy?.action === "save" && busy.id === meta.id}
                onConfigChange={(values) => patch(meta.id, values, true)}
                onUiChange={(values) => patch(meta.id, values)}
                onSave={() => void save(meta.id)}
                onTest={() => void test(meta.id)}
                onClear={() => void clear(meta.id, meta.displayName)}
                onSetDefault={() => void setDefault(meta.id)}
              />
            );
          })
        )}
      </ConnCardGrid>
    </section>
  );
}

interface CardProps {
  meta: ProviderMeta;
  state: ProviderState;
  isDefault: boolean;
  isConfigured: boolean;
  disabled: boolean;
  testing: boolean;
  saving: boolean;
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
  disabled,
  testing,
  saving,
  onConfigChange,
  onUiChange,
  onSave,
  onTest,
  onClear,
  onSetDefault,
}: CardProps) {
  const { t } = useT();
  const statusBadge = useMemo(() => {
    if (testing) return <Badge variant="info">{t("settingsX.searchConn.statusTesting")}</Badge>;
    if (state.probe?.status === "ok")
      return <Badge variant="success">{t("settingsX.searchConn.statusOk")}</Badge>;
    if (state.probe?.status === "error")
      return <Badge variant="error">{t("settingsX.searchConn.statusError")}</Badge>;
    if (state.probe?.status === "unconfigured" || !isConfigured) {
      return <Badge variant="secondary">{t("settingsX.searchConn.statusUnconfigured")}</Badge>;
    }
    return <Badge variant="secondary">{t("settingsX.searchConn.statusUntested")}</Badge>;
  }, [testing, state.probe, isConfigured, t]);

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
                {" "}
                · {formatProbeTime(state.probe.lastProbedAt)}
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
          disabled={disabled || !isConfigured}
          title={
            isConfigured
              ? t("settingsX.searchConn.testConnTitle")
              : t("settingsX.searchConn.fillCredsFirst")
          }
        >
          {testing ? t("settingsX.searchConn.statusTesting") : t("settingsX.searchConn.testSearch")}
        </Button>
        <Button variant="solid" size="sm" onClick={onSave} disabled={disabled || !state.dirty}>
          {saving ? t("settingsX.searchConn.saving") : t("settingsX.searchConn.save")}
        </Button>
        <ConnFooterRight>
          {isConfigured && !isDefault && (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={onSetDefault}>
              {t("settingsX.searchConn.setDefault")}
            </Button>
          )}
          {isConfigured && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-status-err"
              onClick={onClear}
              disabled={disabled}
            >
              {t("settingsX.searchConn.clear")}
            </Button>
          )}
        </ConnFooterRight>
      </ConnCardFooter>
    </ConnCard>
  );
}
