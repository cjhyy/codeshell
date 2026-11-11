import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "../../i18n";
import { PET_NOTIFICATION_DIGEST_SLOTS_MAX } from "../../../shared/pet-notices";
import { heartbeatUsage } from "./noticeRuleText";
import {
  digestSlotsValid,
  isClockTime,
  type PetNotificationsController,
  type PetNotificationsDraft,
} from "./PetNotificationsFields";

/** A new digest slot starts at a common time not already taken. */
const SLOT_SUGGESTIONS = ["12:00", "18:00", "09:00", "15:00", "21:00", "07:00"];

function nextSlot(slots: readonly string[]): string {
  return SLOT_SUGGESTIONS.find((time) => !slots.includes(time)) ?? "12:00";
}

function BriefField({
  brief,
  draft,
  controller,
}: {
  brief: "morning" | "evening";
  draft: PetNotificationsDraft;
  controller: PetNotificationsController;
}) {
  const { t } = useT();
  const enabled = draft[`${brief}Enabled`];
  const time = draft[`${brief}Time`];
  const name = t(`mimiSettings.proactive.${brief}Label`);
  const switchId = `pet-proactive-${brief}`;
  return (
    <div className="grid gap-2" data-pet-proactive-field={brief}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={switchId}>{name}</Label>
          <p className="text-xs text-muted-foreground">
            {t(`mimiSettings.proactive.${brief}Hint`)}
          </p>
        </div>
        <Switch
          id={switchId}
          checked={enabled}
          aria-label={name}
          onCheckedChange={(checked) =>
            controller.update({ [`${brief}Enabled`]: checked } as Partial<PetNotificationsDraft>)
          }
        />
      </div>
      <Input
        type="time"
        className="w-32"
        aria-label={t("mimiSettings.proactive.timeAria", { name })}
        aria-invalid={!isClockTime(time) || undefined}
        data-pet-proactive-input={`${brief}-time`}
        value={time}
        disabled={!enabled}
        onChange={(event) =>
          controller.update({
            [`${brief}Time`]: event.target.value,
          } as Partial<PetNotificationsDraft>)
        }
        onBlur={controller.flush}
      />
      {!isClockTime(time) && (
        <p role="alert" className="text-xs text-status-err">
          {t("mimiSettings.proactive.invalidTime")}
        </p>
      )}
    </div>
  );
}

/**
 * 主动: the morning brief, the evening wrap-up, the heartbeat and the digest
 * slots. Same draft and touched-only writes as the rest of the card: only the
 * settings the owner edits are written, so the others keep following the
 * host defaults; main then re-syncs Mimi's system rules from them.
 */
export function PetProactiveFields({ controller }: { controller: PetNotificationsController }) {
  const { t } = useT();
  const { draft } = controller;
  if (!draft) return null;
  const usage = heartbeatUsage(controller.proactive, t, "mimiSettings.proactive.heartbeatUsage");
  const capped =
    controller.proactive?.heartbeat.atJudgeCap === true ||
    controller.proactive?.heartbeat.atSayCap === true;
  const hoursValid = isClockTime(draft.heartbeatStart) && isClockTime(draft.heartbeatEnd);
  const slots = draft.digestSlots;
  const setSlots = (next: string[]) => {
    controller.update({ digestSlots: next });
    controller.flush();
  };
  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0" data-pet-proactive>
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{t("mimiSettings.proactive.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("mimiSettings.proactive.hint")}</p>
      </div>

      <BriefField brief="morning" draft={draft} controller={controller} />
      <BriefField brief="evening" draft={draft} controller={controller} />

      <div className="grid gap-2" data-pet-proactive-field="heartbeat">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="pet-proactive-heartbeat">
              {t("mimiSettings.proactive.heartbeatLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("mimiSettings.proactive.heartbeatHint")}
            </p>
          </div>
          <Switch
            id="pet-proactive-heartbeat"
            checked={draft.heartbeatEnabled}
            aria-label={t("mimiSettings.proactive.heartbeatLabel")}
            onCheckedChange={(checked) => controller.update({ heartbeatEnabled: checked })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="time"
            className="w-32"
            aria-label={t("mimiSettings.proactive.activeStart")}
            aria-invalid={!isClockTime(draft.heartbeatStart) || undefined}
            data-pet-proactive-input="heartbeat-start"
            value={draft.heartbeatStart}
            disabled={!draft.heartbeatEnabled}
            onChange={(event) => controller.update({ heartbeatStart: event.target.value })}
            onBlur={controller.flush}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="time"
            className="w-32"
            aria-label={t("mimiSettings.proactive.activeEnd")}
            aria-invalid={!isClockTime(draft.heartbeatEnd) || undefined}
            data-pet-proactive-input="heartbeat-end"
            value={draft.heartbeatEnd}
            disabled={!draft.heartbeatEnabled}
            onChange={(event) => controller.update({ heartbeatEnd: event.target.value })}
            onBlur={controller.flush}
          />
        </div>
        {!hoursValid && (
          <p role="alert" className="text-xs text-status-err">
            {t("mimiSettings.proactive.invalidTime")}
          </p>
        )}
        {usage && (
          <p className="text-xs text-muted-foreground" data-pet-proactive-usage>
            {usage}
            {capped && ` ${t("mimiSettings.proactive.heartbeatCapped")}`}
          </p>
        )}
      </div>

      <div className="grid gap-2" data-pet-proactive-field="digest-slots">
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium" id="pet-proactive-slots-label">
            {t("mimiSettings.proactive.slotsLabel")}
          </div>
          <p className="text-xs text-muted-foreground">{t("mimiSettings.proactive.slotsHint")}</p>
        </div>
        {slots.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-pet-proactive-slots-empty>
            {t("mimiSettings.proactive.slotsEmpty")}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-labelledby="pet-proactive-slots-label">
            {slots.map((slot, index) => (
              <li key={index} className="flex items-center gap-1" data-pet-proactive-slot={index}>
                <Input
                  type="time"
                  className="w-32"
                  aria-label={t("mimiSettings.proactive.slotAria", { index: index + 1 })}
                  aria-invalid={!isClockTime(slot) || undefined}
                  value={slot}
                  onChange={(event) =>
                    controller.update({
                      digestSlots: slots.map((value, at) =>
                        at === index ? event.target.value : value,
                      ),
                    })
                  }
                  onBlur={controller.flush}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  data-pet-proactive-remove-slot={index}
                  aria-label={t("mimiSettings.proactive.removeSlot", { time: slot || "--:--" })}
                  onClick={() => setSlots(slots.filter((_, at) => at !== index))}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-pet-proactive-add-slot
            disabled={slots.length >= PET_NOTIFICATION_DIGEST_SLOTS_MAX}
            onClick={() => setSlots([...slots, nextSlot(slots)])}
          >
            <Plus className="size-4" aria-hidden />
            {t("mimiSettings.proactive.addSlot")}
          </Button>
          {slots.length >= PET_NOTIFICATION_DIGEST_SLOTS_MAX && (
            <span className="text-xs text-muted-foreground">
              {t("mimiSettings.proactive.slotsMax", { max: PET_NOTIFICATION_DIGEST_SLOTS_MAX })}
            </span>
          )}
        </div>
        {!digestSlotsValid(slots) && (
          <p role="alert" className="text-xs text-status-err" data-pet-proactive-slots-invalid>
            {t("mimiSettings.proactive.slotsInvalid")}
          </p>
        )}
      </div>
    </div>
  );
}
