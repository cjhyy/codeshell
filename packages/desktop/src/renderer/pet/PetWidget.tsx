import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import dogIcon from "../assets/codeshell-dog-icon.png";
import { useT } from "../i18n";
import { Badge } from "../ui/Badge";

export function PetWidget({
  runningCount,
  activityCount,
  unreadCompletedCount,
  expanded,
  onToggle,
  onClose,
}: {
  runningCount: number;
  activityCount: number;
  unreadCompletedCount: number;
  expanded: boolean;
  onToggle: () => void;
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
  } | null>(null);

  React.useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    },
    [],
  );

  const running = Math.max(0, runningCount);
  const activity = Math.max(0, activityCount);
  const completed = Math.max(0, unreadCompletedCount);
  const summary = t("pet.widget.workSummary", { activity, completed, running });
  return (
    <button
      type="button"
      data-pet-widget="desktop-window"
      className="group absolute bottom-0 right-0 flex h-28 w-28 touch-none cursor-grab items-center justify-center overflow-hidden border-0 bg-transparent p-0 outline-none active:cursor-grabbing focus-visible:drop-shadow-[0_0_6px_hsl(var(--cs-primary)/0.55)]"
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
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (Math.hypot(event.screenX - drag.pointerX, event.screenY - drag.pointerY) >= 4) {
          drag.moved = true;
        }
        if (!drag.moved) return;
        window.codeshell.pet.moveWidget({
          x: event.screenX - drag.offsetX,
          y: event.screenY - drag.offsetY,
        });
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (!drag.moved) {
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null;
            onToggle();
          }, 220);
        }
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
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
      aria-expanded={expanded}
      aria-label={`${t(expanded ? "pet.widget.collapseSessions" : "pet.widget.expandSessions")}：${summary}`}
      title={`${summary} · ${t("pet.widget.dragHint")}`}
    >
      <img
        src={dogIcon}
        alt=""
        draggable={false}
        className="cs-pet-idle h-24 w-24 select-none object-contain drop-shadow-[0_5px_5px_rgb(0_0_0/0.18)] transition-transform group-hover:scale-105"
      />
      {running > 0 && (
        <span
          data-pet-indicator="running"
          className="motion-reduce:animate-none absolute bottom-3 left-3 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-background bg-status-info"
          aria-hidden="true"
        />
      )}
      {activity > 0 && (
        <span className="absolute right-1 top-1" data-pet-indicator="activity">
          <Badge count={activity} />
        </span>
      )}
      <span
        data-pet-indicator="toggle"
        className="absolute left-1 top-1 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-popover/95 text-popover-foreground shadow-md backdrop-blur transition-transform group-hover:scale-105"
        aria-hidden="true"
      >
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
      </span>
    </button>
  );
}
