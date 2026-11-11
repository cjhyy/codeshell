import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { PetLongTaskArtifact } from "@cjhyy/code-shell-pet";

/**
 * Open items on owner notices (design §7 / §9, phase 2b). A notice about a
 * stuck, failed or finished Session can be answered from the owner's private
 * IM chat in their own words ("继续吧", "交给 Mimi", "打开看看"): the reply is
 * read by a model against the open items of that conversation, never by a
 * text pattern (pet-notice-reply-interpreter.ts). What the item may do, its
 * internal code and its one-shot state live on the notice's ledger record
 * (`NoticeRecord.actions`), apart from decision prompts (`prompt`).
 *
 * This module is pure: types, the stored shape's parser, the internal code,
 * the item's natural reply line, and artifact collection for "打开" (from
 * structured sources only: changed files, long-task artifacts).
 */

export type NoticeActionFamily = "goal" | "limit" | "failure" | "open";
export type NoticeActionRuntime = "native" | "external";
/** What an open item can be asked to do (the model picks one of an item's own). */
export type NoticeActionVerb =
  | "reply"
  | "stop"
  | "continue"
  | "retry"
  | "handoff"
  | "open"
  | "confirm";

/** Where an item went out over IM and its number there (①②③, stable while it is open). */
export interface NoticeSlot {
  channel: string;
  ordinal: number;
}

/** Something a finished Session produced that the owner can open on the computer (untrusted). */
export type NoticeArtifact =
  | { kind: "file"; path: string; label?: string }
  | { kind: "url"; url: string; label?: string };

/** The open item a notice carries and what it may still do (one per notice). */
export interface NoticeActions {
  /** Internal id: 12 upper-case hex characters (never asked of the owner). */
  code: string;
  family: NoticeActionFamily;
  sessionId: string;
  runtime: NoticeActionRuntime;
  /** goal / limit: why the Session stopped. */
  reason?: "user" | "limit" | "goal_exhausted";
  /** The Goal that stopped; a reply only acts while it is still this Goal at this revision. */
  goalId?: string;
  revision?: number;
  /** The long task driving the Session, when there was one. */
  taskId?: string;
  /** failure: 重试 is offered (a failed long task, or the last user message to resend). */
  retry?: true;
  /** open: what 打开 opens, in list order. */
  artifacts?: NoticeArtifact[];
  expiresAt: number;
  /** An action ran (one-shot; open may repeat). */
  usedAt?: number;
  /** open: a link outside the allowed hosts the owner was asked about. */
  confirm?: { item: number; expiresAt: number; usedAt?: number };
  /** Set by the router when the item goes out over IM. */
  slot?: NoticeSlot;
}

/** What a notice asks for; the router gives it its code and expiry when it records it. */
export type NoticeActionsInput = Omit<
  NoticeActions,
  "code" | "expiresAt" | "usedAt" | "confirm" | "slot"
>;

/** Items (and a pending link confirmation) stay answerable this long. */
export const NOTICE_ACTION_TTL_MS = 24 * 60 * 60_000;
export const MAX_NOTICE_ARTIFACTS = 8;
const MAX_FILES = 5;
const MAX_TEXT = 1_024;
const MAX_PATH = 4_096;
const MAX_URL = 2_048;
const CODE = /^[0-9A-F]{12}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const FAMILIES: readonly NoticeActionFamily[] = ["goal", "limit", "failure", "open"];
const REASONS = ["user", "limit", "goal_exhausted"] as const;
const ACTION_KEYS = [
  "code",
  "family",
  "sessionId",
  "runtime",
  "reason",
  "goalId",
  "revision",
  "taskId",
  "retry",
  "artifacts",
  "expiresAt",
  "usedAt",
  "confirm",
  "slot",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isText(value: unknown, max = MAX_TEXT): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !CONTROL_CHARS.test(value)
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseArtifact(value: unknown): NoticeArtifact | undefined {
  if (!isRecord(value)) return undefined;
  if (value.label !== undefined && !isText(value.label, 200)) return undefined;
  if (value.kind === "file" && hasOnlyKeys(value, ["kind", "path", "label"]))
    return isText(value.path, MAX_PATH) && isAbsolute(value.path)
      ? (value as unknown as NoticeArtifact)
      : undefined;
  if (value.kind === "url" && hasOnlyKeys(value, ["kind", "url", "label"]))
    return isText(value.url, MAX_URL) && isHttpUrl(value.url)
      ? (value as unknown as NoticeArtifact)
      : undefined;
  return undefined;
}

/** A stored slot: an IM channel and an ordinal 1–99. */
export function parseNoticeSlot(value: unknown): NoticeSlot | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["channel", "ordinal"])) return undefined;
  return isText(value.channel, 64) &&
    Number.isSafeInteger(value.ordinal) &&
    (value.ordinal as number) >= 1 &&
    (value.ordinal as number) <= 99
    ? (value as unknown as NoticeSlot)
    : undefined;
}

function parseConfirm(value: unknown): NoticeActions["confirm"] | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["item", "expiresAt", "usedAt"])) return undefined;
  if (
    !isTimestamp(value.item) ||
    !isTimestamp(value.expiresAt) ||
    (value.usedAt !== undefined && !isTimestamp(value.usedAt))
  )
    return undefined;
  return value as unknown as NoticeActions["confirm"];
}

/** Strict validator for a stored `actions` field; undefined when anything is off. */
export function parseNoticeActions(value: unknown): NoticeActions | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ACTION_KEYS)) return undefined;
  const { artifacts } = value;
  if (
    typeof value.code !== "string" ||
    !CODE.test(value.code) ||
    !FAMILIES.includes(value.family as NoticeActionFamily) ||
    !isText(value.sessionId, 256) ||
    (value.runtime !== "native" && value.runtime !== "external") ||
    (value.reason !== undefined && !REASONS.includes(value.reason as never)) ||
    (value.goalId !== undefined && !isText(value.goalId, 256)) ||
    (value.revision !== undefined &&
      (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)) ||
    (value.taskId !== undefined && !isText(value.taskId, 256)) ||
    (value.retry !== undefined && value.retry !== true) ||
    (artifacts !== undefined &&
      (!Array.isArray(artifacts) ||
        artifacts.length > MAX_NOTICE_ARTIFACTS ||
        !artifacts.every((entry) => parseArtifact(entry) !== undefined))) ||
    !isTimestamp(value.expiresAt) ||
    (value.usedAt !== undefined && !isTimestamp(value.usedAt)) ||
    (value.confirm !== undefined && !parseConfirm(value.confirm)) ||
    (value.slot !== undefined && !parseNoticeSlot(value.slot))
  )
    return undefined;
  return value as unknown as NoticeActions;
}

/** A 12-hex reply code bound to its seed (e.g. `["action", recordId, family]`). */
export function noticeActionCode(seed: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(seed)).digest("hex").slice(0, 12).toUpperCase();
}

/** What an item of this family can be asked to do (a pending link adds `confirm`). */
export function actionVerbs(
  actions: Pick<NoticeActions, "family" | "retry" | "confirm">,
): NoticeActionVerb[] {
  switch (actions.family) {
    case "goal":
      return ["reply", "stop", "handoff"];
    case "limit":
      return ["continue", "stop", "handoff"];
    case "failure":
      return actions.retry ? ["retry", "handoff"] : ["handoff"];
    case "open":
      return actions.confirm && actions.confirm.usedAt === undefined
        ? ["open", "confirm"]
        : ["open"];
  }
}

/** The line that ends the notice: what the owner can say, in plain words (no code). */
export function actionHints(
  actions: Pick<NoticeActions, "family" | "retry" | "artifacts">,
): string {
  const count = actions.artifacts?.length ?? 0;
  switch (actions.family) {
    case "goal":
      return "直接回我要对它说的话就行；也可以让它停下，或交给 Mimi。";
    case "limit":
      return "要继续、停下，还是交给 Mimi？直接回我就行。";
    case "failure":
      return actions.retry
        ? "要重试，还是交给 Mimi？直接回我就行。"
        : "要交给 Mimi 处理吗？直接回我就行。";
    case "open":
      return count > 1
        ? `想在电脑上打开结果（共 ${count} 项）就回我。`
        : "想在电脑上打开结果就回我。";
  }
}

/** ①…⑳ for an item's ordinal (then "(21)"). */
export function ordinalLabel(ordinal: number): string {
  return ordinal >= 1 && ordinal <= 20
    ? String.fromCodePoint(0x2460 + ordinal - 1)
    : `(${ordinal})`;
}

/** Hosts 打开 opens without asking: code hosting, and the computer itself. */
const OPEN_HOSTS = ["github.com", "gitlab.com", "gitee.com"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * `open`: a link the host opens at once (GitHub / GitLab / Gitee and their
 * subdomains, `extraHosts`, localhost); `confirm`: any other http(s) link;
 * undefined: not a link that may be opened at all.
 */
export function linkDisposition(
  value: string,
  extraHosts: readonly string[] = [],
): { disposition: "open" | "confirm"; host: string } | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return { disposition: "confirm", host: url.host };
  const host = url.hostname.toLowerCase();
  const allowed = [...OPEN_HOSTS, ...extraHosts.map((entry) => entry.toLowerCase())];
  const open =
    LOCAL_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
  return { disposition: open ? "open" : "confirm", host: url.host };
}

/** Files a run changed (its last `turn_diff`): absolute paths, deleted ones left out. */
export interface ChangedFiles {
  cwd: string;
  paths: string[];
}

function insideLexically(root: string, path: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(path)) return false;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * What 打开 offers for a finished Session, from structured sources only (no
 * prose is read): the run's changed files inside its working directory, then
 * long-task file / URL artifacts. Empty when there is nothing to open.
 */
export function collectNoticeArtifacts(input: {
  changed?: ChangedFiles;
  task?: readonly PetLongTaskArtifact[];
}): NoticeArtifact[] {
  const artifacts: NoticeArtifact[] = [];
  const add = (artifact: NoticeArtifact | undefined) => {
    if (!artifact || !parseArtifact(artifact) || artifacts.length >= MAX_NOTICE_ARTIFACTS) return;
    const same = (other: NoticeArtifact) =>
      artifact.kind === "file"
        ? other.kind === "file" && other.path === artifact.path
        : other.kind === "url" && other.url === artifact.url;
    if (!artifacts.some(same)) artifacts.push(artifact);
  };
  const changed = input.changed;
  if (changed)
    for (const path of changed.paths
      .filter((entry) => insideLexically(changed.cwd, entry))
      .slice(0, MAX_FILES))
      add({ kind: "file", path });
  for (const artifact of input.task ?? []) {
    const label = isText(artifact.label, 200) ? { label: artifact.label } : {};
    if (artifact.kind === "file" && isAbsolute(artifact.reference))
      add({ kind: "file", path: artifact.reference, ...label });
    else if (artifact.kind === "url" && isHttpUrl(artifact.reference))
      add({ kind: "url", url: artifact.reference, ...label });
  }
  return artifacts;
}
