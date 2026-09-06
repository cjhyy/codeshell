import React, { useEffect, useId, useRef, useState } from "react";
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
  const [focusedTab, setFocusedTab] = useState(tab);
  const tabRefs = useRef(new Map<TabKey, HTMLButtonElement>());
  const pageId = useId();
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

  const tabKeys: TabKey[] = ["cookie", "token", "link", "channels"];
  const tabBtn = (key: TabKey, label: string, description: string, Icon: LucideIcon) => (
    <Button
      key={key}
      ref={(node) => {
        if (node) tabRefs.current.set(key, node);
        else tabRefs.current.delete(key);
      }}
      type="button"
      role="tab"
      id={`${pageId}-tab-${key}`}
      variant="ghost"
      className={cn(
        "h-auto min-w-0 items-start justify-start gap-3 whitespace-normal rounded-xl border p-3 text-left focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        tab === key
          ? "border-primary/25 bg-background text-foreground shadow-sm"
          : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
      )}
      aria-selected={tab === key}
      aria-controls={tab === key ? `${pageId}-panel-${key}` : undefined}
      tabIndex={focusedTab === key ? 0 : -1}
      onFocus={() => setFocusedTab(key)}
      onClick={() => {
        setFocusedTab(key);
        setTab(key);
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const current = tabKeys.indexOf(key);
        let next: number;
        switch (event.key) {
          case "ArrowLeft":
            next = (current - 1 + tabKeys.length) % tabKeys.length;
            break;
          case "ArrowRight":
            next = (current + 1) % tabKeys.length;
            break;
          case "Home":
            next = 0;
            break;
          case "End":
            next = tabKeys.length - 1;
            break;
          default:
            return;
        }
        event.preventDefault();
        // Browsing categories does not reload connection state until Enter or
        // Space activates the focused native button.
        setFocusedTab(tabKeys[next]);
        tabRefs.current.get(tabKeys[next])?.focus();
      }}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          tab === key ? "bg-primary/10 text-primary" : "bg-muted/80 text-muted-foreground",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="block text-sm font-semibold leading-5">{label}</span>
        <span className="mt-1 block text-[11px] font-normal leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
    </Button>
  );

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-muted/15 px-6 pb-10 pt-6 max-[720px]:px-4">
      <div className="mx-auto w-full max-w-6xl">
        <header className="mb-6 flex items-start gap-3.5">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/80 bg-background text-primary shadow-sm">
            <KeyRound className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              {t("ext.credentials.pageTitle")}
            </h1>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
              {t("ext.credentials.pageSubtitle")}
            </p>
          </div>
        </header>

        <div
          role="tablist"
          aria-label={t("ext.credentials.tabsAria")}
          className="mb-6 grid w-full min-w-0 grid-cols-2 gap-1.5 rounded-2xl border border-border/70 bg-muted/50 p-1.5 lg:grid-cols-4"
        >
          {tabBtn(
            "cookie",
            t("ext.credentials.tabCookie"),
            t("ext.credentials.cookieDescription"),
            Cookie,
          )}
          {tabBtn(
            "token",
            t("ext.credentials.tabToken"),
            t("ext.credentials.tokenDescription"),
            KeyRound,
          )}
          {tabBtn(
            "link",
            t("ext.credentials.tabLink"),
            t("ext.credentials.linkDescription"),
            Link2,
          )}
          {tabBtn(
            "channels",
            t("ext.credentials.tabChannels"),
            t("ext.credentials.channelsDescription"),
            MessagesSquare,
          )}
        </div>

        <div
          id={`${pageId}-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`${pageId}-tab-${tab}`}
          className="min-w-0"
        >
          {tab === "cookie" && <CookieTab cwd={cwd} activeBucket={activeBucket} />}
          {tab === "token" && <TokenTab cwd={cwd} />}
          {tab === "link" && <LinkTab cwd={cwd} />}
          {tab === "channels" && <ChatGatewayTab />}
        </div>
      </div>
    </div>
  );
}
