import React, { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
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

  // 凭证取用全自动开关(credentialUse.autoApprove,user 级)。开了 AI 用 UseCredential
  // 取凭证不再弹审批。默认关 —— 每次取用都问(或本会话记住)。
  const [autoApprove, setAutoApprove] = useState(false);
  useEffect(() => {
    void window.codeshell.getSettings("user").then((s) => {
      const v = (s as { credentialUse?: { autoApprove?: boolean } } | null)?.credentialUse
        ?.autoApprove;
      setAutoApprove(v === true);
    });
  }, []);
  const toggleAutoApprove = (next: boolean) => {
    setAutoApprove(next);
    void window.codeshell.updateSettings("user", { credentialUse: { autoApprove: next } });
  };

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
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {tabBtn("cookie", t("ext.credentials.tabCookie"))}
          {tabBtn("token", t("ext.credentials.tabToken"))}
          {tabBtn("link", t("ext.credentials.tabLink"))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={autoApprove} onCheckedChange={toggleAutoApprove} />
          {t("ext.credentials.autoApprove")}
        </label>
      </div>
      {tab === "cookie" && <CookieTab cwd={cwd} />}
      {tab === "token" && <TokenTab cwd={cwd} kind="token" />}
      {tab === "link" && <LinkTab cwd={cwd} />}
    </div>
  );
}
