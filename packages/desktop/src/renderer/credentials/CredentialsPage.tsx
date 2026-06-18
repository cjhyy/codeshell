import React, { useState } from "react";
import { Cookie, KeyRound, Link2, type LucideIcon } from "lucide-react";
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

  // 凭证取用免审批改为**逐条**(每条凭证 autoUseByAI 开关,见 CookieTab)。全局总闸
  // credentialUse.autoApprove 后端仍生效(use-gate 读它),只是 UI 不再暴露。

  const tabBtn = (key: TabKey, label: string, Icon: LucideIcon) => (
    <button
      key={key}
      className={
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
        (tab === key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")
      }
      onClick={() => setTab(key)}
    >
      <Icon className="size-4" />
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
        {tabBtn("cookie", t("ext.credentials.tabCookie"), Cookie)}
        {tabBtn("token", t("ext.credentials.tabToken"), KeyRound)}
        {tabBtn("link", t("ext.credentials.tabLink"), Link2)}
      </div>
      {tab === "cookie" && <CookieTab cwd={cwd} />}
      {tab === "token" && <TokenTab cwd={cwd} kind="token" />}
      {tab === "link" && <LinkTab cwd={cwd} />}
    </div>
  );
}
