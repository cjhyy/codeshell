/** Per-app knowledge for Computer Use: notes the model reads when it first
 * works in an app, and stage hints for the character. Bundled, reviewed data;
 * never code. Imported by the CUA proxy, so Node builtins only. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CUA_ELEMENT_KINDS, type CuaElementKind } from "./cua-activity.js";

export type AppPerch = "title-bar" | "beside-target" | "screen-corner";

export interface AppStageHints {
  /** Preferred place for the character while working in this app. */
  perch?: AppPerch;
  /** Control categories the character must never cover in this app. */
  keepClear: CuaElementKind[];
  /** Minimal presence: no walking to targets (calls, presentations). */
  quiet: boolean;
}

export interface AppProfile {
  id: string;
  bundleIds: string[];
  names: string[];
  notes: string;
  stage: AppStageHints;
}

export const MAX_APP_NOTES = 1_500;
export const APP_PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/;
const PERCHES = new Set(["title-bar", "beside-target", "screen-corner"]);

type Scalar = string | boolean | string[];

function scalar(raw: string): Scalar {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(",").map((item) => unquote(item.trim())) : [];
  }
  return unquote(value);
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function list(value: Scalar | undefined, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`);
  return value;
}

/** Strict subset: `key: value`, `key: [a, b]`, and one nested `stage:` block. */
export function parseAppProfile(text: string, id: string): AppProfile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("missing frontmatter");
  const top: Record<string, Scalar> = {};
  const stage: Record<string, Scalar> = {};
  let section: "top" | "stage" = "top";
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = /^ {2}([a-zA-Z]+):\s*(.*)$/.exec(line);
    const field = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (nested && section === "stage") stage[nested[1]!] = scalar(nested[2]!);
    else if (field && field[1] === "stage" && !field[2]!.trim()) section = "stage";
    else if (field) {
      section = "top";
      top[field[1]!] = scalar(field[2]!);
    } else throw new Error(`unreadable line: ${line.slice(0, 60)}`);
  }
  if (top.id !== id || !APP_PROFILE_ID.test(id)) throw new Error("id must match the file name");
  const bundleIds = list(top.bundleIds, "bundleIds");
  const names = list(top.names, "names");
  if (bundleIds.some((value) => !BUNDLE_ID.test(value))) throw new Error("invalid bundle id");
  if (names.some((value) => !value || value.length > 100)) throw new Error("invalid app name");
  if (!bundleIds.length && !names.length) throw new Error("profile matches no app");
  if (stage.perch !== undefined && (typeof stage.perch !== "string" || !PERCHES.has(stage.perch)))
    throw new Error("invalid stage.perch");
  const keepClear = list(stage.keepClear, "stage.keepClear");
  if (keepClear.some((kind) => !CUA_ELEMENT_KINDS.has(kind)))
    throw new Error("invalid stage.keepClear");
  if (stage.quiet !== undefined && typeof stage.quiet !== "boolean")
    throw new Error("invalid stage.quiet");
  const notes = match[2]!.trim();
  if (!notes || notes.length > MAX_APP_NOTES) throw new Error("notes must be 1–1500 characters");
  return {
    id,
    bundleIds,
    names,
    notes,
    stage: {
      ...(stage.perch ? { perch: stage.perch as AppPerch } : {}),
      keepClear: keepClear as CuaElementKind[],
      quiet: stage.quiet === true,
    },
  };
}

export class AppProfileIndex {
  private readonly byBundle = new Map<string, AppProfile>();
  private readonly byName = new Map<string, AppProfile>();
  private readonly ids = new Map<string, AppProfile>();

  constructor(readonly profiles: readonly AppProfile[] = []) {
    for (const profile of profiles) {
      this.ids.set(profile.id, profile);
      for (const bundle of profile.bundleIds) this.byBundle.set(bundle, profile);
      for (const name of profile.names) this.byName.set(name.toLowerCase(), profile);
    }
  }

  byId(id: string | undefined): AppProfile | undefined {
    return id ? this.ids.get(id) : undefined;
  }

  /** Bundle id wins; an exact (case-insensitive) app name is the fallback. */
  match(app: { bundleId?: string; name?: string }): AppProfile | undefined {
    return (
      (app.bundleId ? this.byBundle.get(app.bundleId) : undefined) ??
      (app.name ? this.byName.get(app.name.toLowerCase()) : undefined)
    );
  }
}

/** Load every `<id>.md`; a broken file is skipped and reported, never fatal. */
export function loadAppProfiles(
  directory: string | undefined,
  report: (file: string, error: string) => void = () => {},
): AppProfileIndex {
  if (!directory) return new AppProfileIndex();
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".md"));
  } catch {
    return new AppProfileIndex();
  }
  const profiles: AppProfile[] = [];
  for (const file of files.sort()) {
    try {
      profiles.push(
        parseAppProfile(readFileSync(join(directory, file), "utf8"), file.slice(0, -3)),
      );
    } catch (error) {
      report(file, (error as Error).message);
    }
  }
  return new AppProfileIndex(profiles);
}

/** The app a `get_window_state` or `launch_app` result describes. */
export function describedApp(
  result: unknown,
): { pid?: number; bundleId?: string; name?: string } | undefined {
  const value =
    result && typeof result === "object"
      ? (result as { structuredContent?: unknown }).structuredContent
      : undefined;
  if (!value || typeof value !== "object") return;
  const content = value as Record<string, unknown>;
  const pid =
    typeof content.pid === "number" && Number.isSafeInteger(content.pid) && content.pid > 0
      ? content.pid
      : undefined;
  const bundleId = typeof content.bundle_id === "string" ? content.bundle_id : undefined;
  const name =
    typeof content.app_name === "string"
      ? content.app_name
      : typeof content.name === "string"
        ? content.name
        : undefined;
  return pid || bundleId || name ? { pid, bundleId, name } : undefined;
}

/** Append the app's notes to a successful tool result, as one text part. */
export function withAppNotes(
  response: Record<string, unknown>,
  profile: AppProfile,
): Record<string, unknown> | undefined {
  const result = response.result;
  if (!result || typeof result !== "object") return;
  const { content, isError } = result as { content?: unknown; isError?: unknown };
  if (isError === true || !Array.isArray(content)) return;
  const title = profile.names[0] ?? profile.id;
  return {
    ...response,
    result: {
      ...result,
      content: [
        ...content,
        { type: "text", text: `CodeShell app notes for ${title}:\n${profile.notes}` },
      ],
    },
  };
}
