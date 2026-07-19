import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MemoryStoreView } from "../settings/MemorySection";
import { useT } from "../i18n";
import type { DigitalHumanProfileEntry } from "./types";

export function DigitalHumanMemoryDialog({
  profile,
  onOpenChange,
}: {
  profile: DigitalHumanProfileEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  if (!profile) return null;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("digitalHumans.memory.title", { name: profile.label })}</DialogTitle>
          <DialogDescription>
            {profile.portableMemory
              ? t("digitalHumans.memory.description")
              : t("digitalHumans.memory.disabledDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          <MemoryStoreView level="profile" profileName={profile.name} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
