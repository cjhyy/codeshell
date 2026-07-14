import type { ReactNode } from "react";

export function AppShell({
  platformClass,
  sidebarCollapsed,
  children,
}: {
  platformClass: string;
  sidebarCollapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`relative flex h-screen flex-col overflow-hidden bg-background text-foreground ${platformClass}`.trim()}
      data-sidebar={sidebarCollapsed ? "collapsed" : "open"}
      data-inspector="hidden"
    >
      {children}
    </div>
  );
}

export function AppMainView({
  lifecycle,
  children,
  searchLayer,
}: {
  lifecycle: string | null;
  children: ReactNode;
  searchLayer: ReactNode;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {lifecycle && (
        <div className="border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground">
          {lifecycle}
        </div>
      )}
      {children}
      {searchLayer}
    </main>
  );
}
