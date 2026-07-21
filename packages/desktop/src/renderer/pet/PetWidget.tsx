import React from "react";
import { ChevronDown } from "lucide-react";
import dogIcon from "../assets/codeshell-dog-icon.png";
import { useT } from "../i18n";
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
              onToggleChat();
            }, 220);
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
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
          className="cs-pet-idle h-24 w-24 select-none object-contain drop-shadow-[0_5px_5px_rgb(0_0_0/0.18)] transition-transform group-hover:scale-105"
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
