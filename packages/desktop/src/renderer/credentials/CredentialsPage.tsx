import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Cookie, KeyRound, Link2, MessagesSquare, type LucideIcon } from "lucide-react";
import { TokenTab } from "./TokenTab";
import { LinkTab } from "./LinkTab";
import { CredentialsSectionHeader } from "./CredentialsSectionHeader";
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

/**
 * IM channels are bound in Mimi settings › 消息连接. The old 沟通渠道 tab stays
 * so existing habits (and the last-tab memory) land on a pointer, not a gap.
 */
function ChannelsMovedNotice({ onOpen }: { onOpen?: () => void }) {
  const { t } = useT();
  return (
    <div className="space-y-5" data-channel-page data-channels-moved>
      <CredentialsSectionHeader
        title={t("ext.credentials.channelsMovedTitle")}
        description={t("ext.credentials.channelsMovedDescription")}
        stats={[]}
      />
      {onOpen && (
        <Button type="button" size="sm" data-open-mimi-connections onClick={onOpen}>
          {t("ext.credentials.channelsMovedAction")}
        </Button>
      )}
    </div>
  );
}

/** Full-screen 凭证 page: Cookie / Permission Token / Link, plus the 沟通渠道 pointer. */
export function CredentialsPage({
  activeProjectPath,
  activeBucket = null,
  initialTab,
  onOpenMimiConnections,
}: {
  activeProjectPath: string | null;
  activeBucket?: string | null;
  /** Explicit entry destination; normal navigation restores the last category. */
  initialTab?: TabKey;
  /** Open Mimi settings › 消息连接, where IM channels are bound. */
  onOpenMimiConnections?: () => void;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>(() => initialTab ?? storedTab());
  const [focusedTab, setFocusedTab] = useState(tab);
  const tabRefs = useRef(new Map<TabKey, HTMLButtonElement>());
  const contentRef = useRef<HTMLDivElement>(null);
  const pageId = useId();
  const cwd = activeProjectPath ?? "";

  useEffect(() => {
    try {
      window.localStorage.setItem(CREDENTIALS_LAST_TAB_KEY, tab);
    } catch {
      // Storage is optional; the current tab still works for this visit.
    }
  }, [tab]);

  useLayoutEffect(() => {
    // Async category lists must not clamp or anchor the fixed page chrome.
    if (contentRef.current) contentRef.current.scrollTop = 0;
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
        "h-11 min-w-0 justify-center gap-2 rounded-none border-b-2 px-2 text-[13px] shadow-none transition-colors focus-visible:ring-inset focus-visible:ring-primary/40 sm:justify-start sm:px-4",
        tab === key
          ? "border-primary bg-transparent text-primary hover:bg-transparent"
          : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
      aria-selected={tab === key}
      aria-description={description}
      title={description}
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
        tabRefs.current.get(tabKeys[next])?.focus({ preventScroll: true });
      }}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate font-medium">{label}</span>
    </Button>
  );

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      data-credentials-page
    >
      <div className="shrink-0 overflow-hidden border-b border-border/60 px-6 pt-6 [scrollbar-gutter:stable] max-[720px]:px-4">
        <header className="mx-auto mb-5 w-full max-w-6xl">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              {t("ext.credentials.pageTitle")}
            </h1>
            <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-muted-foreground">
              {t("ext.credentials.pageSubtitle")}
            </p>
          </div>
        </header>

        <div
          role="tablist"
          aria-label={t("ext.credentials.tabsAria")}
          className="mx-auto grid w-full min-w-0 max-w-6xl grid-cols-4 sm:flex"
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
      </div>
      <div
        ref={contentRef}
        data-credentials-scroll
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6 [scrollbar-gutter:stable] max-[720px]:px-4"
      >
        <div
          id={`${pageId}-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`${pageId}-tab-${tab}`}
          className="mx-auto min-w-0 max-w-6xl pb-4"
        >
          {tab === "cookie" && <CookieTab key={cwd} cwd={cwd} activeBucket={activeBucket} />}
          {tab === "token" && <TokenTab key={cwd} cwd={cwd} />}
          {tab === "link" && <LinkTab key={cwd} cwd={cwd} />}
          {tab === "channels" && <ChannelsMovedNotice onOpen={onOpenMimiConnections} />}
        </div>
      </div>
    </div>
  );
}
