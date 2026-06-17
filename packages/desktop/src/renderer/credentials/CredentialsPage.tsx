import React, { useState } from "react";
import { TokenTab } from "./TokenTab";
import { LinkTab } from "./LinkTab";
import { CookieTab } from "./CookieTab";
import { useT } from "../i18n/I18nProvider";

type TabKey = "cookie" | "token" | "link";

/** Full-screen 凭证 page: Cookie / Permission Token / Link (mirrors ManagePage tabs). */
export function CredentialsPage({ activeRepoPath }: { activeRepoPath: string | null }) {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>("cookie");
  const cwd = activeRepoPath ?? "";

  const tabBtn = (key: TabKey, label: string) => (
    <button
      key={key}
      className={
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
        (tab === key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")
      }
      onClick={() => setTab(key)}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-1 text-lg font-semibold">{t("ext.credentials.pageTitle")}</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {t("ext.credentials.pageSubtitle")}
      </p>
      <div className="mb-4 flex items-center gap-1">
        {tabBtn("cookie", t("ext.credentials.tabCookie"))}
        {tabBtn("token", t("ext.credentials.tabToken"))}
        {tabBtn("link", t("ext.credentials.tabLink"))}
      </div>
      {tab === "cookie" && <CookieTab />}
      {tab === "token" && <TokenTab cwd={cwd} kind="token" />}
      {tab === "link" && <LinkTab cwd={cwd} />}
    </div>
  );
}
