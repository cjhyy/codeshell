import React from "react";
import type { ProviderQuota } from "@cjhyy/code-shell-capability-coding/orchestration";
import type { UsageProviderDescriptor } from "../../shared/usage-providers";
import { Button } from "@/components/ui/button";
import { QuotaProviderBlock } from "../cc-room/QuotaPanel";
import { useT } from "../i18n/I18nProvider";

/** Discovery is local metadata only; provider requests always require a click. */
export function UsageProviders() {
  const { t } = useT();
  const [providers, setProviders] = React.useState<UsageProviderDescriptor[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const generation = React.useRef(0);

  const discover = React.useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const result = await window.codeshell.quota.listProviders();
      if (generation.current === current) setProviders(result);
    } catch {
      if (generation.current === current) setError(true);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void discover();
    return () => {
      generation.current++;
    };
  }, [discover]);

  return (
    <section
      aria-labelledby="subscription-usage-heading"
      className="rounded-2xl border border-border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="subscription-usage-heading" className="font-medium">
            {t("usagePage.quotaTitle")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("usagePage.quotaDescription")}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void discover()}>
          {loading ? t("usagePage.discovering") : t("usagePage.rediscover")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-status-err">
          {t("usagePage.discoveryFailed")}
        </p>
      )}
      {!loading && !error && providers.length === 0 && (
        <p className="my-5 text-sm text-muted-foreground">{t("usagePage.noProviders")}</p>
      )}
      {providers.length > 0 && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {providers.map((provider) => (
            <ProviderUsageCard key={provider.id} provider={provider} />
          ))}
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-muted-foreground">{t("usagePage.quotaHint")}</p>
    </section>
  );
}

function ProviderUsageCard({ provider }: { provider: UsageProviderDescriptor }) {
  const { t, lang } = useT();
  const [quota, setQuota] = React.useState<ProviderQuota>();
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [updatedAt, setUpdatedAt] = React.useState<number>();
  const inFlight = React.useRef(false);
  const generation = React.useRef(0);
  React.useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const query = async () => {
    if (inFlight.current || !provider.quota.supported) return;
    inFlight.current = true;
    const current = generation.current;
    setLoading(true);
    setFailed(false);
    setQuota(undefined);
    setUpdatedAt(undefined);
    try {
      const result = await window.codeshell.quota.query(provider.id);
      if (generation.current === current) {
        setQuota(result);
        setUpdatedAt(Date.now());
      }
    } catch {
      if (generation.current === current) setFailed(true);
    } finally {
      if (generation.current === current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  };

  return (
    <article
      aria-label={provider.displayName}
      data-usage-provider={provider.id}
      className="min-w-0 rounded-xl bg-muted/40 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-medium">{provider.displayName}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {provider.source === "cli"
              ? t("usagePage.providerInstalled")
              : t("usagePage.providerConfigured", { count: String(provider.connectionCount ?? 1) })}
          </p>
        </div>
        {provider.quota.supported && (
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void query()}>
            {loading
              ? t("usagePage.quotaLoading")
              : quota || failed
                ? t("usagePage.quotaRefresh")
                : t("usagePage.quotaLoad")}
          </Button>
        )}
      </div>
      {!provider.quota.supported ? (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {t("usagePage.quotaUnsupported")}
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {t(
              provider.quota.queryCost === "minimal-usage"
                ? "usagePage.quotaProbeCost"
                : "usagePage.quotaFreeQuery",
            )}
          </p>
          {failed ? (
            <p role="alert" className="mt-3 text-xs text-status-err">
              {t("usagePage.quotaMissing")}
            </p>
          ) : quota?.errorCode === "auth-required" ? (
            <p role="alert" className="mt-3 text-xs text-status-err">
              {t("usagePage.quotaAuthRequired")}
            </p>
          ) : quota ? (
            <div className="mt-4">
              <QuotaProviderBlock name={provider.displayName} pq={quota} hideName />
            </div>
          ) : !loading ? (
            <p className="mt-3 text-xs text-muted-foreground">{t("usagePage.quotaUnqueried")}</p>
          ) : null}
          {updatedAt && (
            <p className="mt-3 text-xs text-muted-foreground">
              {t("usagePage.quotaChecked", {
                time: new Date(updatedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en-US"),
              })}
            </p>
          )}
        </>
      )}
    </article>
  );
}
