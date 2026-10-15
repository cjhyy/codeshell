import React from "react";
import { Brain, LoaderCircle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MemoryStoreView } from "../settings/MemorySection";
import { useT } from "../i18n";
import { useConfirm } from "../ui/ConfirmDialog";
import type { DigitalHumanProfileEntry } from "./types";
import { useDialogFocus } from "../ui/useDialogFocus";

export function DigitalHumanMemoryDialog({
  profile,
  opener,
  enabling = false,
  onEnable,
  onOpenChange,
}: {
  profile: DigitalHumanProfileEntry | null;
  opener?: HTMLElement | null;
  enabling?: boolean;
  onEnable?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  const dialogFocus = useDialogFocus(!!profile, opener);
  const confirmDialog = useConfirm();
  const confirm: typeof confirmDialog = (options) =>
    dialogFocus.withNestedFocus(() => confirmDialog(options));
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    setDirty(false);
    setSaving(false);
  }, [profile?.name]);
  if (!profile) return null;
  const initials = profile.label.trim().slice(0, 2).toUpperCase() || "DH";
  const requestClose = (open: boolean) => {
    if (!open && saving) return;
    if (open || !dirty) {
      onOpenChange(open);
      return;
    }
    void confirm({
      title: t("settingsX.memory.discardTitle"),
      message: t("settingsX.memory.discardMessage"),
      confirmLabel: t("settingsX.memory.discard"),
      destructive: true,
    }).then((accepted) => {
      if (accepted) onOpenChange(false);
    });
  };
  return (
    <Dialog open onOpenChange={requestClose}>
      <DialogContent
        ref={dialogFocus.contentRef}
        data-dialog-focus-owner={dialogFocus.focusOwnerId}
        onCloseAutoFocus={dialogFocus.onCloseAutoFocus}
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 max-w-5xl flex-col gap-0 overflow-hidden p-0"
        showClose={false}
      >
        <DialogHeader className="shrink-0 flex-row items-start justify-between gap-3 space-y-0 border-b border-border/70 bg-muted/25 px-6 py-5 [@media(max-height:32rem)]:px-4 [@media(max-height:32rem)]:py-3">
          <div className="flex min-w-0 flex-1 items-start gap-3.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-sm font-semibold text-primary shadow-sm [@media(max-height:32rem)]:hidden">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary [@media(max-height:32rem)]:hidden">
                {t("digitalHumans.memory.eyebrow")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle
                  tabIndex={0}
                  data-dialog-scroll
                  className="max-h-[25dvh] min-w-0 overflow-y-auto overscroll-contain text-base leading-5 [overflow-wrap:anywhere]"
                >
                  {t("digitalHumans.memory.title", { name: profile.label })}
                </DialogTitle>
                <Badge variant={profile.portableMemory ? "success" : "secondary"}>
                  {profile.portableMemory
                    ? t("digitalHumans.memory.activeBadge")
                    : t("digitalHumans.memory.inactiveBadge")}
                </Badge>
              </div>
              <DialogDescription className="mt-1.5 max-w-2xl leading-5 [@media(max-height:32rem)]:sr-only">
                {profile.portableMemory
                  ? t("digitalHumans.memory.description")
                  : t("digitalHumans.memory.disabledDescription")}
              </DialogDescription>
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label={t("digitalHumans.close")}
            aria-disabled={saving}
            onClick={() => requestClose(false)}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </DialogHeader>

        <div
          data-dialog-scroll
          role="region"
          tabIndex={0}
          aria-label={t("digitalHumans.memory.title", { name: profile.label })}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5 [overflow-wrap:anywhere] [@media(max-height:32rem)]:p-2"
        >
          <p className="mb-4 hidden text-xs leading-5 text-muted-foreground [@media(max-height:32rem)]:block">
            {profile.portableMemory
              ? t("digitalHumans.memory.description")
              : t("digitalHumans.memory.disabledDescription")}
          </p>
          <div
            className={
              profile.portableMemory
                ? "mb-4 flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/5 p-3.5"
                : "mb-4 flex items-start gap-3 rounded-xl border border-status-warn/20 bg-status-warn/5 p-3.5"
            }
          >
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background text-primary shadow-sm">
              <Brain size={14} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">{t("digitalHumans.memory.workspaceTitle")}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("digitalHumans.memory.workspaceDescription")}
              </p>
            </div>
            {!profile.portableMemory && onEnable ? (
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                disabled={enabling}
                onClick={onEnable}
              >
                {enabling ? (
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Brain className="size-3.5" aria-hidden="true" />
                )}
                {enabling ? t("digitalHumans.memory.enabling") : t("digitalHumans.memory.enable")}
              </Button>
            ) : null}
          </div>
          <MemoryStoreView
            level="profile"
            profileName={profile.name}
            presentation="profile"
            confirmDialog={confirm}
            onDirtyChange={setDirty}
            onSavingChange={setSaving}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
