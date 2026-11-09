import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Switch } from "@/components/ui/switch";
import { useT } from "../i18n";
import { writeSettings } from "../settingsBus";
import { useTargetedDebouncedSave } from "../settings/useTargetedDebouncedSave";
import type { PetApi } from "../../preload/pet-api";
import {
  PET_NOTIFICATION_MAX_PER_HOUR_RANGE,
  type PetNoticeChannel,
  type PetNoticeChannelReadiness,
  type PetNoticesState,
  type PetNotificationSettingsView,
} from "../../shared/pet-notices";

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

/** The editable part of `pet.notifications`, as the inputs hold it. */
export interface PetNotificationsDraft {
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  /** Input text; only an in-range integer is saved. */
  maxPerHour: string;
  delegatedFromDesktop: "auto" | "desktop";
}

export function notificationsDraft(view: PetNotificationSettingsView): PetNotificationsDraft {
  return {
    quietEnabled: view.quietHours.enabled,
    quietStart: view.quietHours.start,
    quietEnd: view.quietHours.end,
    maxPerHour: String(view.maxPerHour),
    delegatedFromDesktop: view.delegatedFromDesktop,
  };
}

/**
 * The settings patch for a draft. A half-typed time or an out-of-range count
 * is left out, so the stored value stays as it was until the input is valid.
 */
export function notificationsSettingsPatch(draft: PetNotificationsDraft): Record<string, unknown> {
  const notifications: Record<string, unknown> = {
    delegatedFromDesktop: draft.delegatedFromDesktop,
  };
  if (HH_MM.test(draft.quietStart) && HH_MM.test(draft.quietEnd))
    notifications.quietHours = {
      enabled: draft.quietEnabled,
      start: draft.quietStart,
      end: draft.quietEnd,
    };
  const max = /^\d+$/u.test(draft.maxPerHour.trim()) ? Number(draft.maxPerHour.trim()) : NaN;
  if (
    Number.isSafeInteger(max) &&
    max >= PET_NOTIFICATION_MAX_PER_HOUR_RANGE.min &&
    max <= PET_NOTIFICATION_MAX_PER_HOUR_RANGE.max
  )
    notifications.maxPerHour = max;
  return { pet: { notifications } };
}

type NoticesApi = Pick<PetApi, "getNoticesState" | "setSystemNoticeRule" | "onNoticesChanged">;
type SettingsWriter = (scope: "user", patch: Record<string, unknown>) => Promise<void>;

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
  // An edit not yet written: a refresh must not overwrite what the owner typed.
  const dirty = useRef(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;

  const persist = (value: PetNotificationsDraft) => {
    const operation = notificationWrites.then(() =>
      write("user", notificationsSettingsPatch(value)),
    );
    notificationWrites = operation.catch(() => {});
    return operation.then(
      () => {
        if (draftRef.current === value) dirty.current = false;
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
    draftRef.current = next;
    dirty.current = true;
    setDraft(next);
    schedule(next);
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

export function PetNotificationsFields({ controller }: { controller: PetNotificationsController }) {
  const { t } = useT();
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
    <div className="grid gap-5">
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

      <div className="flex flex-wrap items-center gap-3" data-pet-notices-field="max-per-hour">
        <Label htmlFor="pet-notices-max-per-hour" className="min-w-0 flex-1">
          {t("pet.notices.maxPerHourLabel")}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="pet-notices-max-per-hour"
            type="number"
            inputMode="numeric"
            className="w-20"
            min={PET_NOTIFICATION_MAX_PER_HOUR_RANGE.min}
            max={PET_NOTIFICATION_MAX_PER_HOUR_RANGE.max}
            step={1}
            value={draft.maxPerHour}
            onChange={(event) => controller.update({ maxPerHour: event.target.value })}
            onBlur={controller.flush}
          />
          <span className="text-xs text-muted-foreground">{t("pet.notices.maxPerHourUnit")}</span>
        </div>
      </div>

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
        <div className="text-sm font-medium">{t("pet.notices.channelsLabel")}</div>
        {controller.channels.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("pet.notices.channelsEmpty")}</p>
        ) : (
          <ul className="grid gap-1.5">
            {controller.channels.map((channel) => (
              <li
                key={channel.id}
                data-pet-notices-channel={channel.id}
                className="flex items-center justify-between gap-3 text-sm"
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

/** "通知与主动": quiet hours, push budget, delegated results, the system rule, IM channels. */
export function PetNotificationsCard({ api, write }: { api?: NoticesApi; write?: SettingsWriter }) {
  const { t } = useT();
  const controller = usePetNotificationsController({
    ...(api ? { api } : {}),
    ...(write ? { write } : {}),
  });
  return (
    <Card data-pet-setting="notifications" className="rounded-2xl">
      <CardHeader className="flex-row items-start gap-3 space-y-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <BellRing size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <CardTitle className="text-base">{t("pet.notices.cardTitle")}</CardTitle>
          <CardDescription className="leading-5">
            {t("pet.notices.cardDescription")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pl-16">
        <PetNotificationsFields controller={controller} />
      </CardContent>
    </Card>
  );
}
