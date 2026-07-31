import React from "react";
import { Brain, LoaderCircle } from "lucide-react";
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

export function DigitalHumanMemoryDialog({
  profile,
  enabling = false,
  onEnable,
  onOpenChange,
}: {
  profile: DigitalHumanProfileEntry | null;
  enabling?: boolean;
  onEnable?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  const confirm = useConfirm();
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
        className="flex max-h-[90vh] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        showClose={!saving}
      >
        <DialogHeader className="border-b border-border/70 bg-muted/25 px-6 py-5 pr-12">
          <div className="flex items-start gap-3.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-sm font-semibold text-primary shadow-sm">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
                {t("digitalHumans.memory.eyebrow")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>
                  {t("digitalHumans.memory.title", { name: profile.label })}
                </DialogTitle>
                <Badge variant={profile.portableMemory ? "success" : "secondary"}>
                  {profile.portableMemory
                    ? t("digitalHumans.memory.activeBadge")
                    : t("digitalHumans.memory.inactiveBadge")}
                </Badge>
              </div>
              <DialogDescription className="mt-1.5 max-w-2xl leading-5">
                {profile.portableMemory
                  ? t("digitalHumans.memory.description")
                  : t("digitalHumans.memory.disabledDescription")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
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
            onDirtyChange={setDirty}
            onSavingChange={setSaving}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
