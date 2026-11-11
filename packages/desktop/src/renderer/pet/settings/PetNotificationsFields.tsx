import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import { writeSettings } from "../../settingsBus";
import { useTargetedDebouncedSave } from "../../settings/useTargetedDebouncedSave";
import type { PetApi } from "../../../preload/pet-api";
import {
  PET_NOTIFICATION_MAX_P0_PER_HOUR_RANGE,
  PET_NOTIFICATION_MAX_PER_HOUR_RANGE,
  PET_NOTIFICATION_MERGE_WINDOW_SEC_RANGE,
  PET_NOTIFICATION_PRESENCE_IDLE_SEC_RANGE,
  type PetNoticeChannel,
  type PetNoticeChannelReadiness,
  type PetNoticesState,
  type PetNotificationSettingsView,
} from "../../../shared/pet-notices";

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

/** The editable part of `pet.notifications`, as the inputs hold it. */
export interface PetNotificationsDraft {
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  /** Input text; only an in-range integer is saved (same for the limits below). */
  maxPerHour: string;
  /** Decision pushes per hour. */
  maxP0PerHour: string;
  /** Seconds a burst of notices is merged into one digest. */
  mergeWindowSec: string;
  /** Seconds of system idle after which the owner counts as away. */
  presenceIdleSec: string;
  delegatedFromDesktop: "auto" | "desktop";
}

type IntegerField = "maxPerHour" | "maxP0PerHour" | "mergeWindowSec" | "presenceIdleSec";

const INTEGER_RANGES: Record<IntegerField, { min: number; max: number }> = {
  maxPerHour: PET_NOTIFICATION_MAX_PER_HOUR_RANGE,
  maxP0PerHour: PET_NOTIFICATION_MAX_P0_PER_HOUR_RANGE,
  mergeWindowSec: PET_NOTIFICATION_MERGE_WINDOW_SEC_RANGE,
  presenceIdleSec: PET_NOTIFICATION_PRESENCE_IDLE_SEC_RANGE,
};

function boundedInteger(text: string, { min, max }: { min: number; max: number }) {
  const value = /^\d+$/u.test(text.trim()) ? Number(text.trim()) : NaN;
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export function notificationsDraft(view: PetNotificationSettingsView): PetNotificationsDraft {
  return {
    quietEnabled: view.quietHours.enabled,
    quietStart: view.quietHours.start,
    quietEnd: view.quietHours.end,
    maxPerHour: String(view.maxPerHour),
    maxP0PerHour: String(view.maxP0PerHour),
    mergeWindowSec: String(view.mergeWindowSec),
    presenceIdleSec: String(view.presenceIdleSec),
    delegatedFromDesktop: view.delegatedFromDesktop,
  };
}

/** A key of `settings.pet.notifications`; the three quiet-hours inputs share one. */
export type NotificationSettingKey = IntegerField | "quietHours" | "delegatedFromDesktop";

/** The stored setting a draft field belongs to. */
export function notificationSettingKey(field: keyof PetNotificationsDraft): NotificationSettingKey {
  return field === "quietEnabled" || field === "quietStart" || field === "quietEnd"
    ? "quietHours"
    : field;
}

/**
 * The settings patch for a draft: only the settings the owner `touched`, so an
 * untouched field keeps following the host default instead of being frozen at
 * today's value. A half-typed time or an out-of-range count is left out too,
 * so the stored value stays as it was until the input is valid.
 */
export function notificationsSettingsPatch(
  draft: PetNotificationsDraft,
  touched: ReadonlySet<NotificationSettingKey>,
): Record<string, unknown> {
  const notifications: Record<string, unknown> = {};
  if (touched.has("delegatedFromDesktop"))
    notifications.delegatedFromDesktop = draft.delegatedFromDesktop;
  if (touched.has("quietHours") && HH_MM.test(draft.quietStart) && HH_MM.test(draft.quietEnd))
    notifications.quietHours = {
      enabled: draft.quietEnabled,
      start: draft.quietStart,
      end: draft.quietEnd,
    };
  for (const field of Object.keys(INTEGER_RANGES) as IntegerField[]) {
    if (!touched.has(field)) continue;
    const value = boundedInteger(draft[field], INTEGER_RANGES[field]);
    if (value !== undefined) notifications[field] = value;
  }
  return { pet: { notifications } };
}

/** A draft and the settings edited in it, as one debounced write. */
interface PendingNotificationsWrite {
  draft: PetNotificationsDraft;
  touched: ReadonlySet<NotificationSettingKey>;
}

export type NoticesApi = Pick<
  PetApi,
  "getNoticesState" | "setSystemNoticeRule" | "onNoticesChanged"
>;
export type SettingsWriter = (scope: "user", patch: Record<string, unknown>) => Promise<void>;

function defaultApi(): NoticesApi | undefined {
  try {
    return window.codeshell?.pet;
  } catch {
    return undefined;
  }
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Survives page navigation: a new card reads after the previous card's flushed writes.
let notificationWrites: Promise<void> = Promise.resolve();

export interface PetNotificationsController {
  loadState: "loading" | "ready" | "error";
  loadError: string;
  channels: PetNoticeChannel[];
  systemRuleOn: boolean;
  systemPending: boolean;
  systemError: string;
  draft: PetNotificationsDraft | null;
  saveError: string;
  update(patch: Partial<PetNotificationsDraft>): void;
  flush(): void;
  setSystemRule(on: boolean): void;
  reload(): void;
}

export function usePetNotificationsController({
  api = defaultApi(),
  write = writeSettings,
}: { api?: NoticesApi; write?: SettingsWriter } = {}): PetNotificationsController {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [state, setState] = useState<PetNoticesState | null>(null);
  const [draft, setDraft] = useState<PetNotificationsDraft | null>(null);
  const [saveError, setSaveError] = useState("");
  const [systemPending, setSystemPending] = useState(false);
  const [systemError, setSystemError] = useState("");
  const draftRef = useRef<PetNotificationsDraft | null>(null);
  // Settings the owner edited on this page; only these are written.
  const touched = useRef(new Set<NotificationSettingKey>());
  // An edit not yet written: a refresh must not overwrite what the owner typed.
  const dirty = useRef(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;

  const persist = (value: PendingNotificationsWrite) => {
    const operation = notificationWrites.then(() =>
      write("user", notificationsSettingsPatch(value.draft, value.touched)),
    );
    notificationWrites = operation.catch(() => {});
    return operation.then(
      () => {
        if (draftRef.current === value.draft) dirty.current = false;
        if (alive.current) setSaveError("");
      },
      (cause: unknown) => {
        if (alive.current) setSaveError(errorText(cause));
        throw cause;
      },
    );
  };
  const { schedule, flush } = useTargetedDebouncedSave("user:pet-notifications", persist);

  const reload = useCallback(() => {
    const current = apiRef.current;
    const id = ++generation.current;
    if (!current?.getNoticesState) {
      setLoadError("unavailable");
      setLoadState("error");
      return;
    }
    void notificationWrites
      .then(() => current.getNoticesState!())
      .then(
        (next) => {
          if (!alive.current || id !== generation.current) return;
          setState(next);
          if (!dirty.current) {
            const fresh = notificationsDraft(next.settings);
            draftRef.current = fresh;
            setDraft(fresh);
          }
          setLoadState("ready");
        },
        (cause: unknown) => {
          if (!alive.current || id !== generation.current) return;
          setLoadError(errorText(cause));
          setLoadState((previous) => (previous === "ready" ? previous : "error"));
        },
      );
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    const off = apiRef.current?.onNoticesChanged?.(reload);
    return () => {
      alive.current = false;
      generation.current += 1;
      off?.();
    };
  }, [reload]);

  const update = (patch: Partial<PetNotificationsDraft>): void => {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, ...patch };
    for (const field of Object.keys(patch) as Array<keyof PetNotificationsDraft>)
      touched.current.add(notificationSettingKey(field));
    draftRef.current = next;
    dirty.current = true;
    setDraft(next);
    schedule({ draft: next, touched: new Set(touched.current) });
  };

  const setSystemRule = (on: boolean): void => {
    const current = apiRef.current;
    if (!current?.setSystemNoticeRule || !state || systemPending) return;
    const previous = state.systemRule;
    setSystemPending(true);
    setSystemError("");
    setState({ ...state, systemRule: { ...previous, state: on ? "active" : "paused" } });
    current.setSystemNoticeRule({ state: on ? "active" : "paused" }).then(
      (systemRule) => {
        if (!alive.current) return;
        setState((latest) => (latest ? { ...latest, systemRule } : latest));
        setSystemPending(false);
      },
      (cause: unknown) => {
        if (!alive.current) return;
        setState((latest) => (latest ? { ...latest, systemRule: previous } : latest));
        setSystemError(errorText(cause));
        setSystemPending(false);
      },
    );
  };

  return {
    loadState,
    loadError,
    channels: state?.channels ?? [],
    systemRuleOn: state?.systemRule.state === "active",
    systemPending,
    systemError,
    draft,
    saveError,
    update,
    flush,
    setSystemRule,
    reload,
  };
}

const READINESS_VARIANT: Record<PetNoticeChannelReadiness, "success" | "warning" | "error"> = {
  ready: "success",
  unknown: "warning",
  unavailable: "error",
};

function LimitField({
  id,
  field,
  label,
  hint,
  unit,
  draft,
  controller,
}: {
  id: string;
  field: IntegerField;
  label: string;
  hint?: string;
  unit?: string;
  draft: PetNotificationsDraft;
  controller: PetNotificationsController;
}) {
  const range = INTEGER_RANGES[field];
  return (
    <div className="flex flex-wrap items-center gap-3" data-pet-notices-field={field}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          className="w-24"
          min={range.min}
          max={range.max}
          step={1}
          value={draft[field]}
          onChange={(event) =>
            controller.update({ [field]: event.target.value } as Partial<PetNotificationsDraft>)
          }
          onBlur={controller.flush}
        />
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

/**
 * The editable notification preferences. `onManageChannels` adds the jump to
 * the binding UI (Mimi settings › 消息连接); the advanced limits start folded.
 */
export function PetNotificationsFields({
  controller,
  onManageChannels,
  defaultAdvancedOpen = false,
}: {
  controller: PetNotificationsController;
  onManageChannels?: () => void;
  defaultAdvancedOpen?: boolean;
}) {
  const { t } = useT();
  const advancedId = useId();
  const [advancedOpen, setAdvancedOpen] = useState(defaultAdvancedOpen);
  const { draft, loadState } = controller;
  const readiness: Record<PetNoticeChannelReadiness, string> = {
    ready: t("pet.notices.readyReady"),
    unknown: t("pet.notices.readyUnknown"),
    unavailable: t("pet.notices.readyUnavailable"),
  };
  if (loadState === "loading" || (loadState === "ready" && !draft))
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("ext.common.loading")}
      </p>
    );
  if (loadState === "error" || !draft)
    return (
      <div className="grid gap-2">
        <p role="alert" className="text-sm text-status-err [overflow-wrap:anywhere]">
          {t("ext.common.loadFailed", { error: controller.loadError })}
        </p>
        <Button type="button" className="justify-self-start" onClick={controller.reload}>
          {t("ext.common.retry")}
        </Button>
      </div>
    );
  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div className="grid gap-2" data-pet-notices-field="quiet-hours">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="pet-notices-quiet-enabled">{t("pet.notices.quietHoursLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("pet.notices.quietHoursHint")}</p>
          </div>
          <Switch
            id="pet-notices-quiet-enabled"
            checked={draft.quietEnabled}
            onCheckedChange={(checked) => controller.update({ quietEnabled: checked })}
            aria-label={t("pet.notices.quietHoursLabel")}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="time"
            className="w-32"
            aria-label={t("pet.notices.quietHoursStart")}
            data-pet-notices-input="quiet-start"
            value={draft.quietStart}
            disabled={!draft.quietEnabled}
            onChange={(event) => controller.update({ quietStart: event.target.value })}
            onBlur={controller.flush}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="time"
            className="w-32"
            aria-label={t("pet.notices.quietHoursEnd")}
            data-pet-notices-input="quiet-end"
            value={draft.quietEnd}
            disabled={!draft.quietEnabled}
            onChange={(event) => controller.update({ quietEnd: event.target.value })}
            onBlur={controller.flush}
          />
        </div>
      </div>

      <LimitField
        id="pet-notices-max-per-hour"
        field="maxPerHour"
        label={t("pet.notices.maxPerHourLabel")}
        unit={t("pet.notices.maxPerHourUnit")}
        draft={draft}
        controller={controller}
      />

      <div className="flex flex-wrap items-center gap-3" data-pet-notices-field="delegated">
        <Label className="min-w-0 flex-1">{t("pet.notices.delegatedLabel")}</Label>
        <div className="w-64">
          <SimpleSelect
            size="sm"
            ariaLabel={t("pet.notices.delegatedLabel")}
            value={draft.delegatedFromDesktop}
            onChange={(value) => {
              if (value === "auto" || value === "desktop")
                controller.update({ delegatedFromDesktop: value });
            }}
            options={[
              { value: "auto", label: t("pet.notices.delegatedAuto") },
              { value: "desktop", label: t("pet.notices.delegatedDesktop") },
            ]}
          />
        </div>
      </div>

      <div className="grid gap-1" data-pet-notices-field="system-rule">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="pet-notices-system-rule">{t("pet.notices.systemRuleLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("pet.notices.systemRuleHint")}</p>
          </div>
          <Switch
            id="pet-notices-system-rule"
            checked={controller.systemRuleOn}
            disabled={controller.systemPending}
            onCheckedChange={controller.setSystemRule}
            aria-label={t("pet.notices.systemRuleLabel")}
          />
        </div>
        {controller.systemError && (
          <p role="alert" className="text-xs text-status-err [overflow-wrap:anywhere]">
            {t("pet.notices.systemRuleFailed", { error: controller.systemError })}
          </p>
        )}
      </div>

      <div className="grid gap-2" data-pet-notices-field="channels">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">{t("pet.notices.channelsLabel")}</div>
          {onManageChannels && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-pet-notices-manage-channels
              onClick={onManageChannels}
            >
              {controller.channels.length === 0
                ? t("pet.notices.bindChannels")
                : t("pet.notices.manageChannels")}
            </Button>
          )}
        </div>
        {controller.channels.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("pet.notices.channelsEmpty")}</p>
        ) : (
          <ul className="grid min-w-0 gap-1.5">
            {controller.channels.map((channel) => (
              <li
                key={channel.id}
                data-pet-notices-channel={channel.id}
                className="flex min-w-0 items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 truncate">{channel.label}</span>
                <Badge variant={READINESS_VARIANT[channel.ready]} data-ready={channel.ready}>
                  {readiness[channel.ready]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("pet.notices.channelsNote")}</p>
      </div>

      <div
        className="rounded-xl border border-border/70"
        data-pet-notices-advanced={advancedOpen ? "open" : "collapsed"}
      >
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-between rounded-xl px-3 py-2.5 text-left font-normal whitespace-normal"
          aria-expanded={advancedOpen}
          aria-controls={advancedOpen ? advancedId : undefined}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span className="min-w-0 space-y-0.5">
            <span className="block text-sm font-medium">{t("pet.notices.advancedLabel")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("pet.notices.advancedHint")}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              advancedOpen && "rotate-180",
            )}
            aria-hidden
          />
        </Button>
        {advancedOpen && (
          <div id={advancedId} className="grid gap-4 border-t border-border/60 px-3 py-3">
            <LimitField
              id="pet-notices-max-p0-per-hour"
              field="maxP0PerHour"
              label={t("pet.notices.maxP0PerHourLabel")}
              hint={t("pet.notices.maxP0PerHourHint")}
              unit={t("pet.notices.maxPerHourUnit")}
              draft={draft}
              controller={controller}
            />
            <LimitField
              id="pet-notices-merge-window"
              field="mergeWindowSec"
              label={t("pet.notices.mergeWindowLabel")}
              hint={t("pet.notices.mergeWindowHint")}
              unit={t("pet.notices.secondsUnit")}
              draft={draft}
              controller={controller}
            />
            <LimitField
              id="pet-notices-presence-idle"
              field="presenceIdleSec"
              label={t("pet.notices.presenceIdleLabel")}
              hint={t("pet.notices.presenceIdleHint")}
              unit={t("pet.notices.secondsUnit")}
              draft={draft}
              controller={controller}
            />
          </div>
        )}
      </div>

      {controller.saveError ? (
        <p role="alert" className="text-sm text-status-err [overflow-wrap:anywhere]">
          {t("pet.notices.saveFailed", { error: controller.saveError })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("pet.notices.saveHint")}</p>
      )}
    </div>
  );
}
