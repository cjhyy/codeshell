/**
 * Host system affordances for Panel Apps: opening https links in the system
 * browser after consent, rate-limited system notifications, and microphone
 * consent plus speech-to-text. Audio is never persisted by the bridge.
 */
import { BrowserWindow, dialog, shell } from "electron";
import type { GuestBinding, PanelAppBridgeInternals } from "./panel-app-bridge-types.js";
import {
  AUDIO_MIME_TYPES,
  MAX_AUDIO_TRANSCRIBE_BYTES,
  MAX_NOTIFICATIONS_PER_WINDOW,
  MAX_TRANSCRIPT_CHARS,
  RATE_WINDOW_MS,
} from "./panel-app-bridge-support.js";

export async function panelOpenExternal(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): Promise<boolean> {
  const rawUrl = (params as { url?: unknown } | null)?.url;
  let url: URL;
  try {
    url = new URL(typeof rawUrl === "string" ? rawUrl : "");
  } catch {
    throw new Error("external.open only accepts https URLs");
  }
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length > 2048 ||
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("external.open only accepts https URLs");
  }
  const owner = BrowserWindow.fromId(binding.ownerWindowId);
  if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
  const decision = await dialog.showMessageBox(owner, {
    type: "question",
    buttons: ["Open", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: binding.resource.descriptor.title,
    message: "Open this link in your system browser?",
    detail: url.toString(),
    noLink: true,
  });
  if (decision.response !== 0) return false;
  await shell.openExternal(url.toString());
  return true;
}

export function panelSendNotification(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): boolean {
  const body = (params as { body?: unknown } | null)?.body;
  const title = (params as { title?: unknown } | null)?.title;
  if (typeof body !== "string" || body.trim().length === 0 || body.length > 500) {
    throw new Error("notifications.send requires a non-empty body up to 500 characters");
  }
  if (
    title !== undefined &&
    (typeof title !== "string" || title.length === 0 || title.length > 80)
  ) {
    throw new Error("notifications.send title must be 1-80 characters");
  }
  const limits = bridge.options.limits;
  const now = Date.now();
  binding.notifyTimes = binding.notifyTimes.filter(
    (time) => now - time < (limits?.rateWindowMs ?? RATE_WINDOW_MS),
  );
  if (
    binding.notifyTimes.length >=
    (limits?.maxNotificationsPerWindow ?? MAX_NOTIFICATIONS_PER_WINDOW)
  ) {
    throw new Error("Panel App notification limit exceeded");
  }
  binding.notifyTimes.push(now);
  const show = bridge.options.showNotification;
  if (!show) throw new Error("system notifications are unavailable");
  // The trusted app title always prefixes the shown title so one Panel App
  // cannot impersonate CodeShell or another app.
  return show({
    title: title
      ? `${binding.resource.descriptor.title}: ${title}`
      : binding.resource.descriptor.title,
    body: body.trim(),
  });
}

function panelAudioHost(bridge: PanelAppBridgeInternals, binding: GuestBinding) {
  const host = bridge.options.audioTranscription;
  if (!host) throw new Error("Panel App audio transcription host is unavailable");
  if (!binding.context.cwd || !binding.context.trusted) {
    throw new Error("Panel App audio transcription requires a trusted workspace");
  }
  return host;
}

export function panelAudioStatus(bridge: PanelAppBridgeInternals, binding: GuestBinding): unknown {
  const host = panelAudioHost(bridge, binding);
  return host.status(binding.context.cwd!);
}

export function panelRequestMicrophoneAccess(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
): Promise<{ granted: boolean }> {
  return panelAudioHost(bridge, binding).requestMicrophoneAccess();
}

export async function panelTranscribeAudio(
  bridge: PanelAppBridgeInternals,

  binding: GuestBinding,
  params: unknown,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const input = params as {
    audio?: unknown;
    mimeType?: unknown;
    language?: unknown;
  } | null;
  if (!(input?.audio instanceof ArrayBuffer)) {
    throw new Error("audio.transcribe requires raw ArrayBuffer audio");
  }
  if (input.audio.byteLength === 0 || input.audio.byteLength > MAX_AUDIO_TRANSCRIBE_BYTES) {
    throw new Error("audio.transcribe audio must be between 1 byte and 25 MiB");
  }
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.trim().toLowerCase() : "";
  const baseMimeType = mimeType.split(";", 1)[0] ?? "";
  if (!AUDIO_MIME_TYPES.has(baseMimeType)) {
    throw new Error("audio.transcribe MIME type is not supported");
  }
  const language =
    typeof input.language === "string" && input.language.trim() ? input.language.trim() : undefined;
  if (language && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language)) {
    throw new Error("audio.transcribe language must be an ISO language tag");
  }
  const host = panelAudioHost(bridge, binding);
  const result = await host.transcribe({
    cwd: binding.context.cwd!,
    audio: new Uint8Array(input.audio),
    mimeType,
    ...(language ? { language } : {}),
  });
  if (!result.ok) return result;
  const text = result.text.trim();
  if (!text) return { ok: false, error: "transcription returned no text" };
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    return { ok: false, error: "transcription exceeds the 20000 character limit" };
  }
  return { ok: true, text };
}
