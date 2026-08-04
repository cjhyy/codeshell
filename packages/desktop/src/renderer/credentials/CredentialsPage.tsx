import React, { useEffect, useState } from "react";
import { Cookie, KeyRound, Link2, MessagesSquare, type LucideIcon } from "lucide-react";
import { TokenTab } from "./TokenTab";
import { ChatGatewayTab, LinkTab } from "./LinkTab";
import { CookieTab } from "./CookieTab";
import { useT } from "../i18n/I18nProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TabKey = "cookie" | "token" | "link" | "channels";

const CREDENTIALS_LAST_TAB_KEY = "codeshell:credentials:last-tab";

function storedTab(): TabKey {
  if (typeof window === "undefined") return "cookie";
  try {
    const value = window.localStorage.getItem(CREDENTIALS_LAST_TAB_KEY);
    return value === "cookie" || value === "token" || value === "link" || value === "channels"
      ? value
      : "cookie";
  } catch {
    return "cookie";
  }
}

/** Full-screen 凭证 page: Cookie / Permission Token / Link / 沟通渠道。 */
export function CredentialsPage({
  activeProjectPath,
  activeBucket = null,
}: {
  activeProjectPath: string | null;
  activeBucket?: string | null;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>(storedTab);
  const cwd = activeProjectPath ?? "";

  useEffect(() => {
    try {
      window.localStorage.setItem(CREDENTIALS_LAST_TAB_KEY, tab);
    } catch {
      // Storage is optional; the current tab still works for this visit.
    }
  }, [tab]);

  // 凭证取用免审批改为**逐条**(每条凭证 autoUseByAI 开关,见 CookieTab)。全局总闸
  // credentialUse.autoApprove 后端仍生效(use-gate 读它),只是 UI 不再暴露。

  const tabBtn = (key: TabKey, label: string, Icon: LucideIcon) => (
    <Button
      key={key}
      type="button"
      role="tab"
      variant="ghost"
      size="sm"
      className={cn(
        "h-10 min-w-max flex-1 gap-2 rounded-lg px-3 text-sm",
        tab === key
          ? "bg-background text-foreground shadow-sm ring-1 ring-border/60"
          : "text-muted-foreground hover:text-foreground",
      )}
      aria-selected={tab === key}
      aria-controls={`credentials-panel-${key}`}
      onClick={() => setTab(key)}
    >
      <Icon className="size-4" />
      {label}
    </Button>
  );

  return (
    <div className="h-full overflow-y-auto bg-background px-6 pb-10 pt-6 max-[720px]:px-4">
      <div className="mx-auto w-full max-w-6xl">
        <header className="mb-5 border-b border-border pb-4">
          <h1 className="text-xl font-semibold tracking-tight">{t("ext.credentials.pageTitle")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("ext.credentials.pageSubtitle")}
          </p>
        </header>

        <div
          role="tablist"
          aria-label={t("ext.credentials.tabsAria")}
          className="mb-5 grid w-full grid-cols-2 gap-1 rounded-xl border border-border/70 bg-muted/45 p-1 lg:grid-cols-4"
        >
          {tabBtn("cookie", t("ext.credentials.tabCookie"), Cookie)}
          {tabBtn("token", t("ext.credentials.tabToken"), KeyRound)}
          {tabBtn("link", t("ext.credentials.tabLink"), Link2)}
          {tabBtn("channels", t("ext.credentials.tabChannels"), MessagesSquare)}
        </div>

        <div id={`credentials-panel-${tab}`} role="tabpanel">
          {tab === "cookie" && <CookieTab cwd={cwd} activeBucket={activeBucket} />}
          {tab === "token" && <TokenTab cwd={cwd} />}
          {tab === "link" && <LinkTab cwd={cwd} />}
          {tab === "channels" && <ChatGatewayTab />}
        </div>
      </div>
    </div>
  );
}
