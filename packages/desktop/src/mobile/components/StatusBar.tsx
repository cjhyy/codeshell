import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type { ConnStatus } from "@cjhyy/code-shell-web";
import type { RunState } from "@cjhyy/code-shell-web";

const CONN_LABEL_KEY: Record<
  ConnStatus,
  | "mobile.status.conn.connecting"
  | "mobile.status.conn.authenticating"
  | "mobile.status.conn.unpaired"
  | "mobile.status.conn.online"
  | "mobile.status.conn.offline"
> = {
  connecting: "mobile.status.conn.connecting",
  authenticating: "mobile.status.conn.authenticating",
  unpaired: "mobile.status.conn.unpaired",
  online: "mobile.status.conn.online",
  offline: "mobile.status.conn.offline",
};

const RUN_LABEL_KEY: Record<
  RunState,
  | "mobile.status.run.idle"
  | "mobile.status.run.running"
  | "mobile.status.run.waiting"
  | "mobile.status.run.completed"
  | "mobile.status.run.error"
> = {
  idle: "mobile.status.run.idle",
  running: "mobile.status.run.running",
  waiting: "mobile.status.run.waiting",
  completed: "mobile.status.run.completed",
  error: "mobile.status.run.error",
};

/** A status pip + label. When online, shows the run state; otherwise the
 *  connection state. Colors come from the shared status tokens. */
export function StatusBar({ conn, run }: { conn: ConnStatus; run: RunState }) {
  const { t } = useT();
  const online = conn === "online";
  const tone = !online
    ? conn === "offline" || conn === "unpaired"
      ? "err"
      : "running"
    : run === "running"
      ? "running"
      : run === "waiting"
        ? "warn"
        : run === "error"
          ? "err"
          : run === "completed"
            ? "ok"
            : "idle";
  const label = online ? t(RUN_LABEL_KEY[run]) : t(CONN_LABEL_KEY[conn]);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-medium",
        "border-border/75 bg-white/[0.045] text-muted-foreground shadow-[0_1px_0_rgb(255_255_255_/_0.04)_inset]",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "ok" && "bg-status-ok",
          tone === "running" && "animate-pulse bg-status-running",
          tone === "warn" && "bg-status-warn",
          tone === "err" && "bg-status-err",
          tone === "idle" && "bg-status-idle",
        )}
      />
      {label}
    </span>
  );
}
