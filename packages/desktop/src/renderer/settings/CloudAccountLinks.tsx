import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import type { CloudAccountLinkView, CloudAccountLinksRequest } from "../../shared/cloud-account.js";

type Target = { kind: "connections" | "grants"; id: string };

/** An explicit account-owned view; a failed request never becomes an empty list or a successful revoke. */
export function CloudAccountLinks({
  identity,
  enabled,
  pending,
  current,
}: {
  identity: { origin: string; accountId: string };
  enabled: boolean;
  pending: boolean;
  current: () => boolean;
}) {
  const { t } = useT();
  const [view, setView] = useState<CloudAccountLinkView>();
  const [review, setReview] = useState<Target>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const allowed = () => active.current && current();
  const list = async () => {
    const result = await window.codeshell.cloudAccount.manageLinks({ ...identity, action: "list" });
    if (!allowed()) return;
    if (result.action !== "list") throw new Error(t("settingsX.cloudAccount.linksInvalid"));
    setView(result.view);
    setUncertain(false);
  };
  const act = async (target?: Target) => {
    if (!allowed() || working.current || pending || !enabled) return;
    working.current = true;
    setBusy(true);
    setError("");
    setReview(undefined);
    let confirmed = false;
    try {
      if (target) {
        const request: CloudAccountLinksRequest = { ...identity, action: "revoke", ...target };
        const result = await window.codeshell.cloudAccount.manageLinks(request);
        if (!allowed()) return;
        if (
          result.action !== "revoke" ||
          !result.revoked ||
          result.kind !== target.kind ||
          result.id !== target.id
        )
          throw new Error(t("settingsX.cloudAccount.linksInvalid"));
        confirmed = true;
        setView(
          (previous) =>
            previous && {
              ...previous,
              connections: previous.connections.map((item) =>
                target.kind === "connections" && item.id === target.id
                  ? { ...item, revoked: true }
                  : item,
              ),
              grants: previous.grants.map((item) =>
                (
                  target.kind === "connections"
                    ? item.connectionId === target.id
                    : item.id === target.id
                )
                  ? { ...item, revoked: true }
                  : item,
              ),
            },
        );
      }
      await list();
    } catch (cause) {
      if (!allowed()) return;
      setUncertain(true);
      const message = cause instanceof Error ? cause.message : t("settingsX.cloudAccount.failed");
      setError(
        `${target ? t(confirmed ? "settingsX.cloudAccount.linksConfirmedReloadFailed" : "settingsX.cloudAccount.linksRevokeUnconfirmed") + " " : ""}${message}`,
      );
    } finally {
      working.current = false;
      if (allowed()) setBusy(false);
    }
  };
  const disabled = pending || busy || !enabled;
  const reviewedConnection =
    review?.kind === "connections"
      ? view?.connections.find((item) => item.id === review.id)
      : undefined;
  const reviewedGrant =
    review?.kind === "grants" ? view?.grants.find((item) => item.id === review.id) : undefined;
  const grantConnection =
    reviewedGrant && view?.connections.find((item) => item.id === reviewedGrant.connectionId);
  return (
    <section
      className="space-y-3 border-t border-border pt-3"
      aria-label={t("settingsX.cloudAccount.linksTitle")}
    >
      <p className="font-medium">{t("settingsX.cloudAccount.linksTitle")}</p>
      <p className="text-muted-foreground">{t("settingsX.cloudAccount.linksDescription")}</p>
      <Button variant="outline" disabled={disabled} onClick={() => void act()}>
        {t(busy ? "settingsX.cloudAccount.linksLoading" : "settingsX.cloudAccount.linksLoad")}
      </Button>
      {!enabled && <p role="status">{t("settingsX.cloudAccount.linksUnavailable")}</p>}
      {error && (
        <p role="alert" className="text-status-err">
          {error}
        </p>
      )}
      {view && (
        <>
          <p className="break-all text-muted-foreground">{view.linkOrigin}</p>
          {!view.connections.length && (
            <p role="status">{t("settingsX.cloudAccount.linksEmpty")}</p>
          )}
          <ul className="space-y-3">
            {view.connections.map((connection) => (
              <li key={connection.id} className="space-y-2 rounded border border-border p-3">
                <p className="break-all font-medium">
                  {connection.provider} ·{" "}
                  {connection.account.login ?? connection.account.label ?? connection.account.id}
                </p>
                <p>
                  {t(
                    connection.revoked
                      ? "settingsX.cloudAccount.linksRevoked"
                      : "settingsX.cloudAccount.linksActive",
                  )}
                </p>
                {!connection.revoked && (
                  <Button
                    variant="outline"
                    disabled={disabled || uncertain}
                    onClick={() => setReview({ kind: "connections", id: connection.id })}
                  >
                    {t("settingsX.cloudAccount.linksDisconnect")}
                  </Button>
                )}
                <ul className="space-y-2">
                  {view.grants
                    .filter((grant) => grant.connectionId === connection.id)
                    .map((grant) => (
                      <li key={grant.id} className="space-y-1 border-l border-border pl-3">
                        <p className="break-all font-medium">{grant.client.name}</p>
                        <p>
                          {t(
                            grant.revoked
                              ? "settingsX.cloudAccount.linksRevoked"
                              : "settingsX.cloudAccount.linksActive",
                          )}
                        </p>
                        <p className="break-all">
                          {t("settingsX.cloudAccount.linksScopes")}:{" "}
                          {grant.scopes.join(", ") || "—"}
                        </p>
                        <p className="break-all">
                          {t("settingsX.cloudAccount.linksResources")}:{" "}
                          {grant.resources.join(", ") || "—"}
                        </p>
                        {!grant.revoked && (
                          <Button
                            variant="outline"
                            disabled={disabled || uncertain}
                            onClick={() => setReview({ kind: "grants", id: grant.id })}
                          >
                            {t("settingsX.cloudAccount.linksRevoke")}
                          </Button>
                        )}
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      {review && (reviewedConnection || reviewedGrant) && (
        <div
          role="group"
          aria-label={t("settingsX.cloudAccount.linksReview")}
          className="space-y-2 rounded border border-border p-3"
        >
          <p className="font-medium">{t("settingsX.cloudAccount.linksReview")}</p>
          <p className="break-all">
            {reviewedConnection
              ? `${reviewedConnection.provider} · ${reviewedConnection.account.login ?? reviewedConnection.account.id}`
              : reviewedGrant?.client.name}
          </p>
          {reviewedGrant && (
            <>
              <p className="break-all">
                {grantConnection?.provider} ·{" "}
                {grantConnection?.account.login ??
                  grantConnection?.account.label ??
                  grantConnection?.account.id}
              </p>
              <p className="break-all">
                {reviewedGrant.scopes.join(", ")} · {reviewedGrant.resources.join(", ")}
              </p>
            </>
          )}
          <p>
            {t(
              review.kind === "connections"
                ? "settingsX.cloudAccount.linksDisconnectEffect"
                : "settingsX.cloudAccount.linksRevokeEffect",
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={disabled} onClick={() => setReview(undefined)}>
              {t("settingsX.cloudAccount.linksCancel")}
            </Button>
            <Button disabled={disabled || uncertain} onClick={() => void act(review)}>
              {t("settingsX.cloudAccount.linksConfirm")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
