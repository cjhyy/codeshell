import { useState } from "react";
import { DiscoverHome } from "./DiscoverHome";
import { ManagePage, type TabKey } from "./ManagePage";

interface Props {
  activeRepoPath: string | null;
}

type View =
  | { mode: "home" }
  | { mode: "manage"; tab: TabKey; query?: string };

/**
 * Unified extensions surface (Codex-style). Opens to a minimal discovery
 * home (title + search + installed overview); selecting a count or
 * submitting a search switches into the tabbed management page.
 */
export function ExtensionsPage({ activeRepoPath }: Props) {
  const cwd = activeRepoPath ?? "/";
  const [view, setView] = useState<View>({ mode: "home" });

  return (
    <div className="ext-page">
      {view.mode === "home" ? (
        <DiscoverHome
          cwd={cwd}
          onOpenManage={(tab, query) => setView({ mode: "manage", tab, query })}
        />
      ) : (
        <>
          <button
            className="ext-home-back"
            onClick={() => setView({ mode: "home" })}
          >
            ‹ 返回
          </button>
          <ManagePage
            cwd={cwd}
            activeRepoPath={activeRepoPath}
            initialTab={view.tab}
            initialQuery={view.query}
          />
        </>
      )}
    </div>
  );
}
