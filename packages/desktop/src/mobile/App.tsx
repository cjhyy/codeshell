import { useEffect, useState } from "react";
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
      which={wide ? "both" : drawer ?? "sessions"}
    />
  );

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <TopBar app={app} wide={wide} onOpenDrawer={(w) => setDrawer(w)} />

      <div className="flex min-h-0 flex-1">
        {/* Tablet: persistent left pane. Phone: drawer overlay. */}
        {wide && (
          <aside className="w-72 shrink-0 border-r border-border">{sidePane}</aside>
        )}
        {!wide && drawer && (
          <div className="fixed inset-0 z-20 flex">
            <div className="w-[78%] max-w-sm bg-background shadow-xl">{sidePane}</div>
            <div className="flex-1 bg-black/40" onClick={() => setDrawer(null)} />
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col">
          <ApprovalsArea app={app} />
          {app.chat.goal && (
            <div className="flex items-center gap-2 border-b border-border bg-card/50 px-3 py-1.5 text-xs">
              <span className="text-muted-foreground">{app.chat.goal}</span>
              {app.activeSessionId && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6"
                  onClick={() => app.extendGoal(app.activeSessionId!)}
                >
                  延长目标
                </Button>
              )}
            </div>
          )}
          <MessageStream chat={app.chat} />
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
  return (
    <header
      className="flex items-center gap-2 border-b border-border bg-card/80 px-3 py-2 backdrop-blur"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      {!wide && (
        <Button size="sm" variant="ghost" onClick={() => onOpenDrawer("sessions")}>
          ☰
        </Button>
      )}
      <div className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-xs font-black text-primary-foreground">
        C
      </div>
      <span className="truncate text-sm font-semibold">{title}</span>
      <div className="ml-auto flex items-center gap-2">
        <StatusBar conn={app.status} run={app.chat.run} />
        {!wide && (
          <Button size="sm" variant="ghost" onClick={() => onOpenDrawer("rooms")}>
            房间
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
      activeSessionId={app.activeSessionId}
      onSelect={(id) => {
        app.selectSession(id);
        onDone();
      }}
      onNew={() => {
        app.newSession();
        onDone();
      }}
      onRefresh={app.refreshSessions}
    />
  );
  const rooms = (
    <RoomList
      rooms={app.rooms}
      projects={app.projects}
      activeRoomId={app.activeRoom?.id}
      onRefresh={app.refreshRooms}
      onOpen={(r) => {
        app.openRoom(r);
        onDone();
      }}
      onCreate={app.createRoom}
      onClose={app.closeRoom}
    />
  );
  if (which === "sessions") return sessions;
  if (which === "rooms") return rooms;
  // both (tablet): split vertically.
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden border-b border-border">{sessions}</div>
      <div className="min-h-0 flex-1 overflow-hidden">{rooms}</div>
    </div>
  );
}

function ApprovalsArea({ app }: { app: ReturnType<typeof useRemoteApp> }) {
  if (app.approvals.length === 0) {
    // Surface the permission-mode control in a thin strip when idle so it's
    // always reachable without an approval pending.
    return (
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">权限</span>
        <PermissionModeControl mode={app.permissionMode} onChange={app.setPermissionMode} />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2 border-b border-border bg-background p-2")}>
      {app.approvals.map((a) => (
        <ApprovalCard
          key={a.requestId}
          approval={a}
          onRespond={(decision, opts) => app.respondApproval(a.requestId, decision, opts)}
        />
      ))}
    </div>
  );
}
