import { useEffect, useState } from "react";
import { DoorOpen, LogOut, Menu, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import { useT } from "@/i18n";
import { useRemoteApp } from "@mobile/hooks/useRemoteApp";
import { ConnectionGate } from "@mobile/components/ConnectionGate";
import { StatusBar } from "@mobile/components/StatusBar";
import { MessageStream } from "@mobile/components/MessageStream";
import { ApprovalCard } from "@mobile/components/ApprovalCard";
import { Composer } from "@mobile/components/Composer";
import { SessionList } from "@mobile/components/SessionList";
import { CcSessionList } from "@mobile/components/CcSessionList";
import { PermissionModeControl } from "@mobile/components/PermissionModeControl";
import { MobileSessionSwitcher } from "@mobile/components/MobileSessionSwitcher";

const WIDE = "(min-width: 820px)";

export function App() {
  const app = useRemoteApp();
  const { t } = useT();
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  // The side pane stacks the project's chat sessions + external CC sessions. On a
  // phone it's a drawer; this just tracks open/closed. (Rooms are no longer a
  // user-facing concept — the room transport is internal to CC sessions.)
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Track the tablet/phone breakpoint.
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Pull the world once we come online. (Rooms are no longer listed in the UI;
  // the hook still pulls the project list on connect for the project picker.)
  useEffect(() => {
    if (app.status === "online") {
      app.refreshSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.status]);

  if (app.status !== "online") {
    return <ConnectionGate status={app.status} />;
  }

  const sidePane = <SidePane app={app} onDone={() => setDrawerOpen(false)} />;
  const conversationKey = app.activeRoom
    ? `room:${app.activeRoom.id}`
    : app.activeSessionId
      ? `session:${app.activeSessionId}`
      : "new";

  return (
    <div className="mobile-shell flex h-dvh flex-col text-foreground">
      <TopBar app={app} wide={wide} onOpenDrawer={() => setDrawerOpen(true)} />

      {app.notice && (
        <div className="border-b border-status-err/40 bg-status-err/10 px-3 py-2 text-xs text-status-err">
          {app.notice}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Tablet: persistent left pane. Phone: drawer overlay. */}
        {wide && (
          <aside className="mobile-panel w-80 shrink-0 border-r border-border/70">{sidePane}</aside>
        )}
        {!wide && drawerOpen && (
          <div className="fixed inset-0 z-20 flex overscroll-contain">
            <div className="mobile-drawer h-full w-[82%] max-w-sm min-w-0">{sidePane}</div>
            <div
              className="flex-1 bg-black/55 backdrop-blur-[2px]"
              onClick={() => setDrawerOpen(false)}
            />
          </div>
        )}

        <main className="mobile-main flex min-h-0 flex-1 flex-col">
          <ApprovalsArea app={app} />
          {app.chat.goal && (
            <div className="flex min-w-0 items-center gap-2 border-b border-border/70 bg-card/45 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{app.chat.goal}</span>
              {app.activeSessionId && (
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6"
                    onClick={() => app.extendGoal(app.activeSessionId!)}
                  >
                    {t("mobile.app.extendGoal")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6"
                    onClick={() => app.clearGoal(app.activeSessionId!)}
                  >
                    {t("mobile.app.clearGoal")}
                  </Button>
                </div>
              )}
            </div>
          )}
          <MessageStream
            conversationKey={conversationKey}
            chat={app.chat}
            loading={app.loading.sessionHistory || app.loading.roomHistory}
            loadingText={
              app.activeRoom ? t("mobile.app.loadingCcSession") : t("mobile.app.loadingSession")
            }
          />
          <Composer
            disabled={app.status !== "online"}
            running={app.chat.run === "running" || app.chat.run === "waiting"}
            onSend={app.sendChat}
            onStop={app.stopRun}
          />
        </main>
      </div>
    </div>
  );
}

function TopBar({
  app,
  wide,
  onOpenDrawer,
}: {
  app: ReturnType<typeof useRemoteApp>;
  wide: boolean;
  onOpenDrawer: () => void;
}) {
  const { t } = useT();
  // A bound "room" here is always an external CC (Claude Code) session — the
  // room is internal transport, so it surfaces to the user as a CC 会话.
  const title = app.activeRoom
    ? app.activeRoom.name
    : app.chat.title || t("mobile.app.conversationFallback");
  const activeSession = app.sessions.find((s) => s.id === app.activeSessionId);
  const subtitle = app.activeRoom
    ? app.activeRoom.cwd
    : app.activeCwd
      ? app.activeCwd
      : activeSession?.cwd
        ? activeSession.cwd
        : app.activeSessionId
          ? t("mobile.app.desktopSession")
          : t("mobile.app.newSession");
  return (
    <header
      className="mobile-topbar flex items-center gap-2 px-3 py-2.5"
      style={{ paddingTop: "max(0.625rem, env(safe-area-inset-top))" }}
    >
      {!wide && (
        <Button
          aria-label={t("mobile.app.openSessionsAria")}
          className="mobile-icon-button shrink-0"
          size="icon"
          variant="outline"
          onClick={onOpenDrawer}
        >
          <Menu />
        </Button>
      )}
      <div className="mobile-logo grid size-8 shrink-0 place-items-center rounded-lg text-xs font-black text-white">
        C
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex w-full min-w-0 items-center gap-2">
          {app.activeRoom && (
            <span className="shrink-0 rounded-full border border-status-ok/35 bg-status-ok/10 px-1.5 text-[10px] font-medium text-status-ok">
              CC
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">{title}</span>
        </div>
        <div className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground">
          {subtitle}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {app.activeRoom && (
          <Button
            aria-label={t("mobile.app.leaveSessionAria")}
            className="mobile-icon-button"
            size="icon"
            variant="outline"
            onClick={app.leaveRoom}
          >
            <DoorOpen />
          </Button>
        )}
        <StatusBar conn={app.status} run={app.chat.run} />
      </div>
    </header>
  );
}

function SidePane({ app, onDone }: { app: ReturnType<typeof useRemoteApp>; onDone: () => void }) {
  const { t } = useT();
  const sessions = (
    <SessionList
      sessions={app.sessions}
      projects={app.projects}
      activeSessionId={app.activeSessionId}
      currentCwd={app.activeCwd}
      activeProjectCwd={app.activeProjectCwd}
      loading={app.loading.sessions}
      unreadSessionIds={app.unreadSessionIds}
      onSelect={(id) => {
        app.selectSession(id);
        onDone();
      }}
      onSelectProject={app.selectProject}
      onNew={(cwd, name) => {
        app.newSession(cwd, name);
        onDone();
      }}
      onRefresh={app.refreshSessions}
    />
  );
  const ccSessions = (
    <CcSessionList
      cwd={app.activeProjectCwd ?? app.activeCwd ?? null}
      probe={app.ccProbe}
      sessions={app.ccSessions}
      loading={app.loading.ccSessions}
      cliKind={app.ccCliKind}
      onCliKindChange={app.setCcCliKind}
      onOpen={(sid, cwd, mode) => {
        app.openCcSession(sid, cwd, mode);
        onDone();
      }}
    />
  );
  const footer = (
    <div className="mobile-safe-bottom flex min-w-0 items-center gap-2 border-t border-border/70 px-3 pt-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {app.deviceName || t("mobile.app.deviceFallback")}
      </span>
      <Button
        aria-label={t("mobile.app.logoutAria")}
        size="icon"
        variant="ghost"
        className="ml-auto size-8 shrink-0"
        onClick={app.logout}
      >
        <LogOut />
      </Button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MobileSessionSwitcher
        activeRoom={app.activeRoom}
        sessionsContent={sessions}
        ccContent={ccSessions}
      />
      {footer}
    </div>
  );
}

function ApprovalsArea({ app }: { app: ReturnType<typeof useRemoteApp> }) {
  const { t } = useT();
  if (app.approvals.length === 0) {
    // Surface the permission-mode control in a thin strip when idle so it's
    // always reachable without an approval pending.
    return (
      <div className="flex min-w-0 items-center gap-2 border-b border-border/70 bg-black/10 px-3 py-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Shield className="size-3" />
          {t("mobile.app.permission")}
        </span>
        <PermissionModeControl mode={app.permissionMode} onChange={app.setPermissionMode} />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "mobile-approval-stack flex max-h-[48dvh] min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain border-b border-border/70 bg-black/18 p-2",
      )}
    >
      {app.approvals.map((a) => (
        <ApprovalCard
          key={a.requestId}
          approval={a}
          onRespond={(decision, opts) => {
            if (a.roomId) {
              // cc-room approval: route to the shared roomManager via the bridge.
              // For an AskUserQuestion the chosen label rides in opts.answer; main
              // bakes it into the CLI's `answers` record (a bare allow would make
              // claude report "did not answer"). Plain tools just echo allow/deny.
              app.respondCcApproval(
                a.roomId,
                a.requestId,
                decision === "approve"
                  ? {
                      behavior: "allow",
                      updatedInput: {},
                      ...(opts?.answer ? { answer: opts.answer } : {}),
                    }
                  : { behavior: "deny", message: opts?.reason || "denied by user" },
              );
            } else {
              app.respondApproval(a.requestId, decision, opts);
            }
          }}
        />
      ))}
    </div>
  );
}
