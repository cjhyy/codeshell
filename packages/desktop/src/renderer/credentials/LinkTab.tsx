import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import { LINK_CATALOG, type LinkIntegration } from "./link-catalog";
import { linkOAuthPrimaryAction } from "./link-oauth-actions";
import type { MaskedCredentialView } from "./types";

/**
 * Link tab = 三方集成市场(Codex 风格)。目录写死在 link-catalog.ts;OAuth
 * credential 已存在时展示登录状态。只有 main 已审计 profile 的集成可发起登录。
 */
export function LinkTab({ cwd: _cwd }: { cwd: string }) {
  const { t } = useT();
  const toast = useToast();
  const [credentials, setCredentials] = useState<MaskedCredentialView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const all = await window.codeshell.credentials.list("");
    setCredentials(all.filter((c) => c.type === "oauth"));
  }, []);

  useEffect(() => void load(), [load]);

  const byIntegration = useMemo(() => {
    const map = new Map<string, MaskedCredentialView>();
    for (const cred of credentials) {
      const provider = cred.meta?.oauthProvider;
      if (provider && !map.has(provider)) map.set(provider, cred);
      const suffix = "-oauth";
      if (cred.id.endsWith(suffix)) {
        const id = cred.id.slice(0, -suffix.length);
        if (id && !map.has(id)) map.set(id, cred);
      }
    }
    return map;
  }, [credentials]);

  const run = async (item: LinkIntegration, action: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(item.id);
    setErrors((current) => ({ ...current, [item.id]: "" }));
    try {
      await action();
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((current) => ({ ...current, [item.id]: message }));
      toast({ message });
      // Refresh failures can persist recovery metadata (notably
      // lastRefreshErrorCode=invalid_grant) before rejecting. Reload without
      // replacing the original action error so the row immediately switches
      // to the relogin action while preserving the provider-facing message.
      try {
        await load();
      } catch {
        // The action error above remains the useful failure to show.
      }
    } finally {
      setBusyId(null);
    }
  };

  const onLogin = (item: LinkIntegration, credential?: MaskedCredentialView) => {
    if (!item.oauthProfileId) return;
    void run(item, async () => {
      await window.codeshell.mcpOAuth.login({
        source: "catalog",
        profileId: item.oauthProfileId!,
        credentialId: credential?.id,
      });
    });
  };

  const onRefresh = (item: LinkIntegration, credential: MaskedCredentialView) => {
    void run(item, async () => {
      await window.codeshell.mcpOAuth.refresh(credential.id);
    });
  };

  const onLogout = (item: LinkIntegration, credential: MaskedCredentialView) => {
    void run(item, async () => {
      const result = await window.codeshell.mcpOAuth.logout(credential.id);
      toast({
        message: result.remoteRevoked
          ? t("ext.link.oauthLogoutDone", { name: item.name })
          : t("ext.link.oauthLogoutWarning", { name: item.name }),
      });
    });
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("ext.link.intro")}</p>

      {LINK_CATALOG.map((cat) => (
        <section key={cat.id} className="space-y-2">
          <h3 className="text-sm font-semibold">{t(cat.titleKey)}</h3>
          <div className="space-y-1">
            {cat.items.map((item) => (
              <LinkIntegrationRow
                key={item.id}
                item={item}
                credential={byIntegration.get(item.id)}
                busy={busyId === item.id}
                error={errors[item.id]}
                onLogin={(credential) => onLogin(item, credential)}
                onRefresh={(credential) => onRefresh(item, credential)}
                onLogout={(credential) => onLogout(item, credential)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function LinkIntegrationRow({
  item,
  credential,
  busy,
  error,
  onLogin,
  onRefresh,
  onLogout,
}: {
  item: LinkIntegration;
  credential?: MaskedCredentialView;
  busy: boolean;
  error?: string;
  onLogin: (credential?: MaskedCredentialView) => void;
  onRefresh: (credential: MaskedCredentialView) => void;
  onLogout: (credential: MaskedCredentialView) => void;
}) {
  const { t } = useT();
  const state = credential?.oauthStatus?.state ?? (credential ? "valid" : "missing");
  const primaryAction = linkOAuthPrimaryAction(credential, Boolean(item.oauthProfileId));
  const status =
    state === "valid"
      ? t("ext.link.oauthStatusValid")
      : state === "expired"
        ? t("ext.link.oauthStatusExpired")
        : state === "invalid"
          ? t("ext.link.oauthStatusInvalid")
          : t("ext.link.oauthStatusMissing");

  return (
    <div className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-accent/50">
      <div
        className={
          "flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white " +
          item.brandColor
        }
        aria-hidden
      >
        {item.brandText}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="text-sm font-medium">{item.name}</div>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              state === "valid"
                ? "bg-status-ok/10 text-status-ok"
                : state === "missing"
                  ? "bg-muted text-muted-foreground"
                  : "bg-status-err/10 text-status-err",
            )}
          >
            {status}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {credential ? (
            <>
              {credential.label} ({credential.id})
              {credential.oauthStatus?.expiresAt
                ? ` · ${new Date(credential.oauthStatus.expiresAt).toLocaleString()}`
                : ""}
            </>
          ) : (
            t(item.descKey)
          )}
        </div>
        {error && <div className="truncate text-xs text-status-err">{error}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {credential ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                primaryAction === "login" ? onLogin(credential) : onRefresh(credential)
              }
              disabled={busy}
            >
              {primaryAction === "login"
                ? t("ext.link.oauthRelogin")
                : t("ext.link.oauthRefresh")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onLogout(credential)} disabled={busy}>
              {t("ext.link.oauthLogout")}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onLogin()}
            disabled={busy || !item.oauthProfileId}
            title={!item.oauthProfileId ? t("ext.link.oauthUnsupported") : undefined}
          >
            {item.oauthProfileId ? t("ext.link.oauthLogin") : t("ext.link.oauthUnsupported")}
          </Button>
        )}
      </div>
    </div>
  );
}
