import { SettingsSchema } from "@cjhyy/code-shell-core";
import type { PetNotificationSettingsView } from "../../shared/pet-notices.js";
import { DEFAULT_MAX_P0_PER_HOUR, DEFAULT_MAX_PER_HOUR } from "./pet-notice-policy.js";
import { errorText, type NoticeRouterSettings } from "./pet-notice-types.js";
import { DEFAULT_PRESENCE_IDLE_SEC } from "./pet-presence.js";

/** Notification preferences read from `settings.pet.notifications` (all optional). */
export interface PetNotificationSettings
  extends
    Required<NoticeRouterSettings>,
    Required<Pick<PetNotificationSettingsView, "briefs" | "heartbeat">> {
  presenceIdleSec: number;
  /** Where a desktop-started delegation's result goes when no rule names a channel. */
  delegatedFromDesktop: "auto" | "desktop";
}

export const DEFAULT_QUIET_HOURS = { start: "23:00", end: "08:30" } as const;
/** Owner decision (2026-11-11): briefs and the heartbeat are off until switched on. */
export const DEFAULT_BRIEF_TIMES = { morning: "09:00", evening: "18:30" } as const;
export const DEFAULT_ACTIVE_HOURS = { start: "09:00", end: "22:00" } as const;
const DEFAULT_MERGE_WINDOW_SEC = 600;
const SETTINGS_TTL_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The settings schema's own `pet.notifications` validator: it holds the
 * bounds, and drops (rather than rejects) any malformed field.
 */
const NOTIFICATIONS_SCHEMA = SettingsSchema.shape.pet.removeDefault().shape.notifications;
type StoredPetNotifications = NonNullable<ReturnType<typeof NOTIFICATIONS_SCHEMA.parse>>;

function storedNotifications(userSettings: unknown): StoredPetNotifications {
  const pet = isRecord(userSettings) ? userSettings.pet : undefined;
  const parsed = NOTIFICATIONS_SCHEMA.safeParse(isRecord(pet) ? pet.notifications : undefined);
  return (parsed.success ? parsed.data : undefined) ?? {};
}

/**
 * `settings.pet.notifications` as the form edits it: defaults applied,
 * quiet-hour times kept while `enabled: false`. Quiet hours are only ever
 * switched off that way; an absent (or null) window is the default one.
 */
export function petNotificationSettingsView(userSettings: unknown): PetNotificationSettingsView {
  const stored = storedNotifications(userSettings);
  const window = stored.quietHours ?? DEFAULT_QUIET_HOURS;
  return {
    quietHours: {
      enabled: stored.quietHours?.enabled !== false,
      start: window.start,
      end: window.end,
    },
    maxPerHour: stored.maxPerHour ?? DEFAULT_MAX_PER_HOUR,
    maxP0PerHour: stored.maxP0PerHour ?? DEFAULT_MAX_P0_PER_HOUR,
    mergeWindowSec: stored.mergeWindowSec ?? DEFAULT_MERGE_WINDOW_SEC,
    presenceIdleSec: stored.presenceIdleSec ?? DEFAULT_PRESENCE_IDLE_SEC,
    delegatedFromDesktop: stored.delegatedFromDesktop ?? "auto",
    briefs: {
      morning: {
        enabled: stored.briefs?.morning?.enabled === true,
        time: stored.briefs?.morning?.time ?? DEFAULT_BRIEF_TIMES.morning,
      },
      evening: {
        enabled: stored.briefs?.evening?.enabled === true,
        time: stored.briefs?.evening?.time ?? DEFAULT_BRIEF_TIMES.evening,
      },
    },
    heartbeat: {
      enabled: stored.heartbeat?.enabled === true,
      activeHours: { ...(stored.heartbeat?.activeHours ?? DEFAULT_ACTIVE_HOURS) },
    },
    digestSlots: [...new Set(stored.digestSlots ?? [])].sort(),
  };
}

/** `settings.pet.notifications` with every field bounded; anything malformed falls back. */
export function parsePetNotificationSettings(userSettings: unknown): PetNotificationSettings {
  const { quietHours, briefs, heartbeat, digestSlots, ...rest } =
    petNotificationSettingsView(userSettings);
  return {
    quietHours: quietHours.enabled ? { start: quietHours.start, end: quietHours.end } : null,
    ...rest,
    briefs: briefs!,
    heartbeat: heartbeat!,
    digestSlots: digestSlots ?? [],
  };
}

/** The quiet-hours line NotifyMe's reply carries; undefined when there is no window. */
export function quietHoursText(settings: PetNotificationSettings): string | undefined {
  const window = settings.quietHours;
  if (!window || window.start === window.end) return undefined;
  return `${window.start}–${window.end} 只推需要你决定的事`;
}

/** The wiring's view of `settings.pet.notifications`: a short routing cache plus change listeners. */
export interface PetNoticeSettingsSource {
  /** The settings this wiring currently routes with (cached for a few seconds). */
  settings(): PetNotificationSettings;
  /** Fresh `pet.notifications` for the settings form (bypasses the routing cache). */
  settingsView(): PetNotificationSettingsView;
  /** `pet.notifications` was written: drop the routing cache and tell listeners. */
  settingsChanged(): void;
  onSettingsChange(listener: () => void): () => void;
  dispose(): void;
}

export function createNoticeSettings(options: {
  readSettings(): unknown;
  now: () => number;
  log: (event: string, data: Record<string, unknown>) => void;
}): PetNoticeSettingsSource {
  const { now, log } = options;
  let cached: { at: number; value: PetNotificationSettings } | undefined;
  const listeners = new Set<() => void>();
  return {
    settings() {
      const at = now();
      if (cached && at - cached.at < SETTINGS_TTL_MS) return cached.value;
      let value: PetNotificationSettings;
      try {
        value = parsePetNotificationSettings(options.readSettings());
      } catch (error) {
        log("pet.notice.settings_read_failed", { error: errorText(error) });
        value = parsePetNotificationSettings(undefined);
      }
      cached = { at, value };
      return value;
    },
    settingsView() {
      try {
        return petNotificationSettingsView(options.readSettings());
      } catch (error) {
        log("pet.notice.settings_read_failed", { error: errorText(error) });
        return petNotificationSettingsView(undefined);
      }
    },
    settingsChanged() {
      cached = undefined;
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          log("pet.notice.settings_listener_failed", { error: errorText(error) });
        }
      }
    },
    onSettingsChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
    },
  };
}
