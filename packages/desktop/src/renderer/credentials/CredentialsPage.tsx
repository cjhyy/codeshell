import React, { useState } from "react";
import { TokenTab } from "./TokenTab";
import { LinkTab } from "./LinkTab";
import { CookieTab } from "./CookieTab";

type TabKey = "cookie" | "token" | "link";

/** Full-screen 凭证 page: Cookie / Permission Token / Link (mirrors ManagePage tabs). */
export function CredentialsPage({ activeRepoPath }: { activeRepoPath: string | null }) {
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
      <h2 className="mb-1 text-lg font-semibold">凭证</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Cookie 登录态桥接、Permission Token、业务方 Link 凭证。
      </p>
      <div className="mb-4 flex items-center gap-1">
        {tabBtn("cookie", "Cookie")}
        {tabBtn("token", "Permission Token")}
        {tabBtn("link", "Link")}
      </div>
      {tab === "cookie" && <CookieTab />}
      {tab === "token" && <TokenTab cwd={cwd} kind="token" />}
      {tab === "link" && <LinkTab cwd={cwd} />}
    </div>
  );
}
