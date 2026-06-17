/**
 * Shared building blocks for the 连接 settings cards (WebSearch / 图片生成 /
 * 视频生成). Extracted so GenConnectionsPanel and SearchConnectionsPanel render
 * identical card chrome without duplicating Tailwind strings.
 */
import React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

/** Responsive grid the connection cards sit in (inside a CollapsibleGroup). */
export function ConnCardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 p-3">
      {children}
    </div>
  );
}

/** One connection card. The default instance gets an accent border. */
export function ConnCard({
  isDefault,
  className,
  children,
}: {
  isDefault?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-lg border border-border bg-card p-4",
        isDefault && "border-primary/50 ring-1 ring-primary/30",
        className,
      )}
    >
      {children}
    </article>
  );
}

/** Labelled field (label on top, optional hint below) for card forms. */
export function ConnField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Password-style key input with a show/hide eye toggle. */
export function SecretKeyInput({
  value,
  show,
  onChange,
  onToggleShow,
  placeholder,
}: {
  value: string;
  show: boolean;
  onChange: (value: string) => void;
  onToggleShow: () => void;
  placeholder?: string;
}) {
  const { t } = useT();
  const resolvedPlaceholder = placeholder ?? t("settingsX.conn.pasteApiKey");
  return (
    <div className="flex gap-1.5">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={resolvedPlaceholder}
        className="min-w-0 flex-1 font-mono text-sm"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground"
        onClick={onToggleShow}
        aria-label={show ? t("settingsX.conn.hideKey") : t("settingsX.conn.showKey")}
      >
        {show ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

/** Probe failure message block (error tone, wraps long provider errors). */
export function ConnProbeError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="break-all rounded-md border border-status-err/25 bg-status-err/5 px-2.5 py-2 text-sm text-status-err">
      {message}
    </div>
  );
}

/** Card footer — pinned to the card bottom so footers align across the grid.
 *  Put primary actions first and wrap destructive ones in `<ConnFooterRight>`. */
export function ConnCardFooter({ children }: { children: React.ReactNode }) {
  return <footer className="mt-auto flex flex-wrap items-center gap-2 pt-1">{children}</footer>;
}

/** Right-aligned group inside ConnCardFooter (设默认 / 删除). */
export function ConnFooterRight({ children }: { children: React.ReactNode }) {
  return <div className="ml-auto flex items-center gap-1">{children}</div>;
}
