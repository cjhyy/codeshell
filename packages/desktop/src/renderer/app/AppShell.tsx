import type { ReactNode } from "react";

export function AppShell({
  platformClass,
  platform,
  sidebarCollapsed,
  isFullscreen = false,
  sidebarIsDialog = false,
  children,
}: {
  platformClass: string;
  platform?: string;
  sidebarCollapsed: boolean;
  isFullscreen?: boolean;
  sidebarIsDialog?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`relative flex h-screen flex-col overflow-hidden text-foreground ${platformClass}`.trim()}
      data-theme-surface="window"
      data-app-shell
      data-platform={platform}
      data-window-state={isFullscreen ? "fullscreen" : "windowed"}
      data-sidebar-mode={sidebarIsDialog ? "drawer" : "inline"}
      data-sidebar={sidebarCollapsed ? "collapsed" : "open"}
      data-inspector="hidden"
    >
      <div
        data-app-shell-content
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}

export function AppMainView({
  lifecycle,
  children,
  searchLayer,
  navigation,
}: {
  lifecycle: string | null;
  children: ReactNode;
  searchLayer: ReactNode;
  navigation?: ReactNode;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {lifecycle && (
        <div className="border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground">
          {lifecycle}
        </div>
      )}
      {navigation ? (
        <>
          {navigation}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
        </>
      ) : (
        children
      )}
      {searchLayer}
    </main>
  );
}
