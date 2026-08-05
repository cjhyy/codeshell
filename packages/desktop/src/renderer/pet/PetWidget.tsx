import React from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../i18n";
import { usePetWidgetSprite, useCanWalk, petVisualState } from "../petSprite";
import { Badge } from "../ui/Badge";

export function PetWidget({
  runningCount,
  activityCount,
  unreadCompletedCount,
  chatExpanded,
  activityExpanded,
  onToggleChat,
  onToggleActivity,
  onOpen,
  onContextMenu,
}: {
  runningCount: number;
  activityCount: number;
  unreadCompletedCount: number;
  chatExpanded: boolean;
  activityExpanded: boolean;
  onToggleChat: () => void;
  onToggleActivity: () => void;
  onOpen: () => void;
  onContextMenu: () => void;
}) {
  const { t } = useT();
  const clickTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    pointerX: number;
    pointerY: number;
    moved: boolean;
    lastX: number;
  } | null>(null);
  // Re-rendering flag (the ref above drives movement; this drives the sprite):
  // true while an actual drag is in progress so the pet cycles its walk frames.
  const [dragging, setDragging] = React.useState(false);
  // Which way the pet faces while dragged; flips as the drag crosses horizontally.
  // The ref mirrors the state so onPointerMove (a hot path) only calls setState
  // on a genuine flip, not on every move that happens to be in the same
  // direction — keeping the pointer path free of needless widget re-renders.
  const [dragDir, setDragDir] = React.useState<"left" | "right">("right");
  const dragDirRef = React.useRef<"left" | "right">("right");
  const faceDrag = React.useCallback((next: "left" | "right"): void => {
    if (dragDirRef.current === next) return;
    dragDirRef.current = next;
    setDragDir(next);
  }, []);
  // Occasional auto-trot: at rest Mimi is a still icon, but every so often she
  // walks a short loop and settles back. This is the only ambient motion — no
  // idle breathe, no shimmer — so the widget stays calm.
  const [autoTrot, setAutoTrot] = React.useState(false);
  const trotClearRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const canWalk = useCanWalk();
  // A brief hop on tap. Cleared by a timer back to the resting sprite.
  const [jumping, setJumping] = React.useState(false);
  const jumpClearRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hop = React.useCallback((): void => {
    setJumping(true);
    if (jumpClearRef.current) clearTimeout(jumpClearRef.current);
    jumpClearRef.current = setTimeout(() => setJumping(false), 650);
  }, []);

  const running = Math.max(0, runningCount);
  const activity = Math.max(0, activityCount);
  const completed = Math.max(0, unreadCompletedCount);

  React.useEffect(() => {
    if (!canWalk) return; // no walk frames → never auto-trot
    // One stable timer; re-arms itself with a randomized calm gap (25–55s) so
    // the trots don't feel metronomic.
    let armed = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const gap = 25_000 + Math.floor(Math.random() * 30_000);
      timer = setTimeout(() => {
        if (!armed) return;
        setAutoTrot(true);
        trotClearRef.current = setTimeout(() => setAutoTrot(false), 2400);
        schedule();
      }, gap);
    };
    schedule();
    return () => {
      armed = false;
      clearTimeout(timer);
    };
  }, [canWalk]);

  React.useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      if (trotClearRef.current) clearTimeout(trotClearRef.current);
      if (jumpClearRef.current) clearTimeout(jumpClearRef.current);
    },
    [],
  );

  const summary = t("pet.widget.workSummary", { activity, completed, running });
  // A tap hop takes precedence; otherwise the work/idle state. Walk-frame cycling
  // (drag or auto-trot) overrides both inside usePetWidgetSprite.
  const baseState = jumping
    ? "jumping"
    : petVisualState({ runningCount: running, alertCount: completed });
  const dogIcon = usePetWidgetSprite(baseState, dragging || autoTrot, dragDir);
  return (
    <div
      data-pet-widget="desktop-window"
      className="group absolute bottom-0 right-0 h-28 w-28 bg-transparent"
    >
      <button
        type="button"
        data-pet-action="chat"
        className="absolute inset-0 flex touch-none cursor-grab items-center justify-center overflow-hidden border-0 bg-transparent p-0 outline-none active:cursor-grabbing focus-visible:drop-shadow-[0_0_6px_hsl(var(--cs-primary)/0.55)]"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX,
            offsetY: event.clientY,
            pointerX: event.screenX,
            pointerY: event.screenY,
            moved: false,
            lastX: event.screenX,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (Math.hypot(event.screenX - drag.pointerX, event.screenY - drag.pointerY) >= 4) {
            if (!drag.moved) setDragging(true); // first real movement → start walking
            drag.moved = true;
          }
          if (!drag.moved) return;
          // Face the direction of travel; ignore tiny jitters (<2px) to avoid flip-flop.
          const dx = event.screenX - drag.lastX;
          if (dx > 2) faceDrag("right");
          else if (dx < -2) faceDrag("left");
          drag.lastX = event.screenX;
          window.codeshell.pet.moveWidget({
            x: event.screenX - drag.offsetX,
            y: event.screenY - drag.offsetY,
          });
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (!drag.moved) {
            hop(); // a little jump on tap
            if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
            clickTimerRef.current = setTimeout(() => {
              clickTimerRef.current = null;
              onToggleChat();
            }, 220);
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggleChat();
          }
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
          onOpen();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
          onContextMenu();
        }}
        aria-expanded={chatExpanded}
        aria-label={`${t(chatExpanded ? "pet.widget.collapseChat" : "pet.widget.expandChat")}：${summary}`}
        title={`${summary} · ${t("pet.widget.dragHint")}`}
      >
        <img
          src={dogIcon}
          alt=""
          draggable={false}
          className="h-24 w-24 select-none object-contain drop-shadow-[0_5px_5px_rgb(0_0_0/0.18)] transition-transform group-hover:scale-105"
        />
        {running > 0 && (
          <span
            data-pet-indicator="running"
            className="motion-reduce:animate-none absolute bottom-3 left-3 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-background bg-status-running"
            aria-hidden="true"
          />
        )}
      </button>

      {(activity > 0 || activityExpanded) && (
        <button
          type="button"
          data-pet-indicator="toggle"
          data-pet-action="activity"
          className="absolute right-1 top-1 z-10 flex min-h-7 min-w-7 items-center justify-center rounded-full bg-transparent px-1 text-popover-foreground transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          onClick={onToggleActivity}
          aria-expanded={activityExpanded}
          aria-label={t(
            activityExpanded ? "pet.widget.collapseSessions" : "pet.widget.expandSessions",
          )}
        >
          {activityExpanded ? <ChevronDown className="h-4 w-4" /> : <Badge count={activity} />}
        </button>
      )}
    </div>
  );
}
