import React, { useId, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "../i18n/I18nProvider";

export function TaskRecordCleanup({
  pending,
  onClear,
}: {
  pending: boolean;
  onClear: (before: number | undefined, confirmation: string) => Promise<void>;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [daysText, setDaysText] = useState("30");
  const [range, setRange] = useState<"older" | "all">("older");
  const id = useId();
  const days = Number(daysText);
  const valid = range === "all" || (Number.isSafeInteger(days) && days >= 1);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t("taskInbox.cleanup")}
          title={t("taskInbox.cleanup")}
        >
          <Trash2 size={14} aria-hidden />
          <span className="hidden @min-[600px]/tasks:inline">{t("taskInbox.cleanup")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t("taskInbox.cleanup")}
        className="max-h-[var(--radix-popover-content-available-height)] w-72 overflow-y-auto p-3"
      >
        <form
          className="space-y-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || pending) return;
            setOpen(false);
            const before =
              range === "all" ? undefined : Math.max(0, Date.now() - days * 86_400_000);
            void onClear(
              before,
              range === "all"
                ? t("taskInbox.confirmClearAll")
                : t("taskInbox.confirmClearOlder", { days }),
            );
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-2 font-medium">{t("taskInbox.cleanup")}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={id}
                checked={range === "all"}
                onChange={() => setRange("all")}
              />
              {t("taskInbox.allEnded")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={id}
                checked={range === "older"}
                onChange={() => setRange("older")}
              />
              {t("taskInbox.olderEnded")}
            </label>
            {range === "older" && (
              <div className="flex items-center gap-2">
                <label htmlFor={id}>{t("taskInbox.days")}</label>
                <Input
                  id={id}
                  type="number"
                  required
                  min={1}
                  step={1}
                  value={daysText}
                  onChange={(e) => setDaysText(e.target.value)}
                  className="h-8 w-24"
                />
              </div>
            )}
          </fieldset>
          <p className="text-xs text-muted-foreground">{t("taskInbox.cleanupScope")}</p>
          <Button type="submit" size="sm" variant="outline" disabled={!valid || pending}>
            {t("taskInbox.reviewCleanup")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
