import React from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../i18n";
import { usePetWidgetSprite, useHasPetSprites, petVisualState } from "../petSprite";
import { Badge } from "../ui/Badge";

export function PetWidget({
  runningCount,
  activityCount,
  unreadCompletedCount,
  chatExpanded,
  activityExpanded,
  onToggleChat,
  onToggleActivity,
  onClose,
}: {
  runningCount: number;
  activityCount: number;
  unreadCompletedCount: number;
  chatExpanded: boolean;
  activityExpanded: boolean;
  onToggleChat: () => void;
  onToggleActivity: () => void;
  onClose: () => void;
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
  // A short-lived playful mood layered over the resting state: a periodic idle
  // wave ("hi") and a jump on click. Cleared by a timer back to the base state.
  const [mood, setMood] = React.useState<"waving" | "jumping" | null>(null);
  const moodTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The default pack is a single static icon; only animate (moods + the idle
  // breathe) when an installed pack actually provides pet art.
  const animated = useHasPetSprites();

  const running = Math.max(0, runningCount);
  const activity = Math.max(0, activityCount);
  const completed = Math.max(0, unreadCompletedCount);

  const flashMood = React.useCallback((next: "waving" | "jumping", ms: number): void => {
    setMood(next);
    if (moodTimerRef.current) clearTimeout(moodTimerRef.current);
    moodTimerRef.current = setTimeout(() => setMood(null), ms);
  }, []);

  // Every ~30s of calm, Mimi waves briefly. The "is it calm right now?" check
  // reads a ref inside one stable interval — depending on running/completed
  // directly would rebuild the interval on every activity tick and reset the
  // 30s countdown, so the wave would almost never fire while work is happening.
  const calmRef = React.useRef(true);
  calmRef.current = running === 0 && completed === 0;
  React.useEffect(() => {
    if (!animated) return; // static default pet: never auto-wave
    const id = setInterval(() => {
      if (calmRef.current) flashMood("waving", 1600);
    }, 30_000);
    return () => clearInterval(id);
  }, [flashMood, animated]);

  React.useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      if (moodTimerRef.current) clearTimeout(moodTimerRef.current);
    },
    [],
  );

  const summary = t("pet.widget.workSummary", { activity, completed, running });
  // Priority: a jump reaction, then work/alert states, then the idle wave; while
  // dragging, usePetWidgetSprite cycles the pack's directional walk frames.
  const baseState =
    mood === "jumping"
      ? "jumping"
      : petVisualState({
          runningCount: running,
          alertCount: completed,
          greeting: mood === "waving",
        });
  const dogIcon = usePetWidgetSprite(baseState, dragging, dragDir);
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
            if (animated) flashMood("jumping", 650); // a playful hop on tap (animated packs only)
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
          onClose();
        }}
        aria-expanded={chatExpanded}
        aria-label={`${t(chatExpanded ? "pet.widget.collapseChat" : "pet.widget.expandChat")}：${summary}`}
        title={`${summary} · ${t("pet.widget.dragHint")}`}
      >
        <img
          src={dogIcon}
          alt=""
          draggable={false}
          className={`${animated && !dragging && !mood ? "cs-pet-idle" : ""} h-24 w-24 select-none object-contain drop-shadow-[0_5px_5px_rgb(0_0_0/0.18)] transition-transform group-hover:scale-105`}
        />
        {running > 0 && (
          <span
            data-pet-indicator="running"
            className="motion-reduce:animate-none absolute bottom-3 left-3 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-background bg-status-info"
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
