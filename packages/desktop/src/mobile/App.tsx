import { useEffect, useState } from "react";
import { DoorOpen, LogOut, Menu, MessageSquare, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@ui/button";
import { useRemoteApp } from "@mobile/hooks/useRemoteApp";
import { ConnectionGate } from "@mobile/components/ConnectionGate";
import { StatusBar } from "@mobile/components/StatusBar";
import { MessageStream } from "@mobile/components/MessageStream";
import { ApprovalCard } from "@mobile/components/ApprovalCard";
import { Composer } from "@mobile/components/Composer";
import { SessionList } from "@mobile/components/SessionList";
import { RoomList } from "@mobile/components/RoomList";
import { CcSessionList } from "@mobile/components/CcSessionList";
import { PermissionModeControl } from "@mobile/components/PermissionModeControl";

const WIDE = "(min-width: 820px)";

export function App() {
  const app = useRemoteApp();
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  const [drawer, setDrawer] = useState<"sessions" | "rooms" | null>(null);

  // Track the tablet/phone breakpoint.
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Pull the world once we come online.
  useEffect(() => {
    if (app.status === "online") {
      app.refreshSessions();
      app.refreshRooms();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.status]);

  if (app.status !== "online") {
    return <ConnectionGate status={app.status} />;
  }

  const sidePane = (
    <SidePane
      app={app}
      onDone={() => setDrawer(null)}
      // On a tablet the side pane shows both lists stacked; on phone the drawer
      // shows the one the user tapped.
      which={wide ? "both" : (drawer ?? "sessions")}
    />
  );

  return (
    <div className="mobile-shell flex h-dvh flex-col text-foreground">
      <TopBar app={app} wide={wide} onOpenDrawer={(w) => setDrawer(w)} />

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
        {!wide && drawer && (
          <div className="fixed inset-0 z-20 flex">
            <div className="mobile-drawer w-[82%] max-w-sm">{sidePane}</div>
            <div
              className="flex-1 bg-black/55 backdrop-blur-[2px]"
              onClick={() => setDrawer(null)}
            />
          </div>
        )}

        <main className="mobile-main flex min-h-0 flex-1 flex-col">
          <ApprovalsArea app={app} />
          {app.chat.goal && (
            <div className="flex items-center gap-2 border-b border-border/70 bg-card/45 px-3 py-2 text-xs">
              <span className="text-muted-foreground">{app.chat.goal}</span>
              {app.activeSessionId && (
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6"
                    onClick={() => app.extendGoal(app.activeSessionId!)}
                  >
                    延长目标
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6"
                    onClick={() => app.clearGoal(app.activeSessionId!)}
                  >
                    清除目标
                  </Button>
                </div>
              )}
            </div>
          )}
          <MessageStream
            chat={app.chat}
            loading={app.loading.sessionHistory || app.loading.roomHistory}
            loadingText={app.activeRoom ? "正在加载房间…" : "正在加载会话…"}
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
  onOpenDrawer: (w: "sessions" | "rooms") => void;
}) {
  const title = app.activeRoom ? app.activeRoom.name : app.chat.title || "对话";
  const activeSession = app.sessions.find((s) => s.id === app.activeSessionId);
  const subtitle = app.activeRoom
    ? app.activeRoom.cwd
    : app.activeCwd
      ? app.activeCwd
      : activeSession?.cwd
        ? activeSession.cwd
      : app.activeSessionId
        ? "桌面会话"
        : "新会话";
  return (
    <header
      className="mobile-topbar flex items-center gap-2 px-3 py-2.5"
      style={{ paddingTop: "max(0.625rem, env(safe-area-inset-top))" }}
    >
      {!wide && (
        <Button
          aria-label="打开会话"
          className="mobile-icon-button"
          size="icon"
          variant="outline"
          onClick={() => onOpenDrawer("sessions")}
        >
          <Menu />
        </Button>
      )}
      <div className="mobile-logo grid size-8 shrink-0 place-items-center rounded-lg text-xs font-black text-white">
        C
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {app.activeRoom && (
            <span className="rounded-full border border-status-ok/35 bg-status-ok/10 px-1.5 text-[10px] font-medium text-status-ok">
              房间
            </span>
          )}
          <span className="truncate text-sm font-semibold leading-5">{title}</span>
        </div>
        <div className="truncate text-[11px] leading-4 text-muted-foreground">{subtitle}</div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {app.activeRoom && (
          <Button
            aria-label="退出房间"
            className="mobile-icon-button"
            size="icon"
            variant="outline"
            onClick={app.leaveRoom}
          >
            <DoorOpen />
          </Button>
        )}
        <StatusBar conn={app.status} run={app.chat.run} />
        {!wide && (
          <Button
            aria-label="打开房间"
            className="mobile-icon-button"
            size="icon"
            variant="outline"
            onClick={() => onOpenDrawer("rooms")}
          >
            <MessageSquare />
          </Button>
        )}
      </div>
    </header>
  );
}

function SidePane({
  app,
  which,
  onDone,
}: {
  app: ReturnType<typeof useRemoteApp>;
  which: "sessions" | "rooms" | "both";
  onDone: () => void;
}) {
  const sessions = (
    <SessionList
      sessions={app.sessions}
      projects={app.projects}
      activeSessionId={app.activeSessionId}
      currentCwd={app.activeCwd}
      activeProjectCwd={app.activeProjectCwd}
      loading={app.loading.sessions}
      onSelect={(id) => {
        app.selectSession(id);
        onDone();
      }}
      onSelectProject={app.selectProject}
      onNew={() => {
        app.newSession();
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
      onOpen={(sid, cwd, mode) => {
        app.openCcSession(sid, cwd, mode);
        onDone();
      }}
    />
  );
  const rooms = (
    <RoomList
      rooms={app.rooms}
      projects={app.projects}
      currentCwd={app.activeCwd}
      activeRoomId={app.activeRoom?.id}
      loading={app.loading.rooms}
      onRefresh={app.refreshRooms}
      onOpen={(r) => {
        app.openRoom(r);
        onDone();
      }}
      onCreate={app.createRoom}
      onClose={app.closeRoom}
    />
  );
  const footer = (
    <div className="mobile-safe-bottom flex items-center gap-2 border-t border-border/70 px-3 pt-2 text-xs text-muted-foreground">
      <span className="truncate">{app.deviceName || "设备"}</span>
      <Button
        aria-label="退出登录"
        size="icon"
        variant="ghost"
        className="ml-auto size-8"
        onClick={app.logout}
      >
        <LogOut />
      </Button>
    </div>
  );

  if (which === "sessions")
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">{sessions}</div>
        {footer}
      </div>
    );
  if (which === "rooms")
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-hidden border-b border-border/70">{rooms}</div>
        <div className="min-h-0 flex-1 overflow-hidden">{ccSessions}</div>
        {footer}
      </div>
    );
  // both (tablet): split vertically.
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden border-b border-border/70">{sessions}</div>
      <div className="min-h-0 flex-1 overflow-hidden border-b border-border/70">{rooms}</div>
      <div className="min-h-0 flex-1 overflow-hidden">{ccSessions}</div>
      {footer}
    </div>
  );
}

function ApprovalsArea({ app }: { app: ReturnType<typeof useRemoteApp> }) {
  if (app.approvals.length === 0) {
    // Surface the permission-mode control in a thin strip when idle so it's
    // always reachable without an approval pending.
    return (
      <div className="flex items-center gap-2 border-b border-border/70 bg-black/10 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Shield className="size-3" />
          权限
        </span>
        <PermissionModeControl mode={app.permissionMode} onChange={app.setPermissionMode} />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2 border-b border-border/70 bg-black/18 p-2")}>
      {app.approvals.map((a) => (
        <ApprovalCard
          key={a.requestId}
          approval={a}
          onRespond={(decision, opts) => {
            if (a.roomId) {
              // cc-room approval: route to the shared roomManager via the bridge.
              app.respondCcApproval(
                a.roomId,
                a.requestId,
                decision === "approve"
                  ? { behavior: "allow", updatedInput: {} }
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
