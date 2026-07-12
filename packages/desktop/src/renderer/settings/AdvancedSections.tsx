import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, Trash2 } from "lucide-react";
import { NO_REPO_KEY, type SessionIndex } from "../transcripts";
import { projectLabel, type TrackedProject } from "../projects";
import { useConfirm, truncateTitle } from "../ui/ConfirmDialog";
import { usePrompt } from "../ui/DialogProvider";
import { useToast } from "../ui/ToastProvider";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConnectionsPanel } from "./SearchConnectionsPanel";
import {
  DEFAULT_GIT_PREFS,
  loadGitPrefs,
  normalizeBranchPrefix,
  saveGitPrefs,
  type GitPrefs,
} from "../gitPrefs";
import { writeSettings } from "../settingsBus";
import { ProjectPicker } from "./ProjectPicker";
import type { PluginHookEntry } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import QRCode from "qrcode";
import { useT } from "../i18n/I18nProvider";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";

interface ScopedProps {
  scope: "user" | "project";
  activeProjectPath: string | null;
}

type MobileRemoteMode = "lan" | "tunnel";

const MOBILE_REMOTE_MODE_KEY = "codeshell.mobileRemote.mode";

export function loadMobileRemoteMode(): MobileRemoteMode {
  try {
    const raw = globalThis.localStorage?.getItem(MOBILE_REMOTE_MODE_KEY);
    return raw === "tunnel" ? "tunnel" : "lan";
  } catch {
    return "lan";
  }
}

function saveMobileRemoteMode(mode: MobileRemoteMode): void {
  try {
    globalThis.localStorage?.setItem(MOBILE_REMOTE_MODE_KEY, mode);
  } catch {
    // Best-effort UI preference; private mode/tests may reject storage access.
  }
}

/**
 * Auto-save hook for free-text settings fields.
 *
 * Debounces writes (default 600ms) while typing, and exposes a `flush` to save
 * immediately on blur — so a quick tab-away never loses the last keystrokes.
 * The whole personalization tab auto-saves; no Save buttons (a Switch toggles
 * instantly, text persists on pause/blur).
 */
function useDebouncedSave(persist: (value: string) => Promise<void> | void, delay = 600) {
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current !== null) {
      const value = pending.current;
      pending.current = null;
      void persistRef.current(value);
    }
  }, []);

  const schedule = useCallback(
    (value: string) => {
      pending.current = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const v = pending.current;
        pending.current = null;
        if (v !== null) void persistRef.current(v);
      }, delay);
    },
    [delay],
  );

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
  }, []);

  // Flush any pending write on unmount (e.g. switching tabs/scopes).
  useEffect(() => () => flush(), [flush]);

  return { schedule, flush, cancel };
}

/**
 * Settings → 自定义指令.
 *
 * One large textarea mapping to the agent's `appendSystemPrompt` — extra
 * instructions/context layered onto the system prompt for every conversation.
 * Auto-saves (debounced while typing, flushed on blur); no Save button.
 *
 * The richer instruction-file knobs (customSystemPrompt / instructions.fileName
 * / scanDirs / compatFileNames) were intentionally dropped from this tab to
 * match Codex; they remain in the settings schema and can be set via the config
 * file. Memory enable/skip/reset toggles live in the dedicated 记忆 tab.
 */
export function PersonalizationSection({ scope, activeProjectPath }: ScopedProps) {
  const [instructions, setInstructions] = useState("");
  const { t } = useT();

  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;

  const { schedule, flush } = useDebouncedSave((value) =>
    writeSettings(scope, { agent: { appendSystemPrompt: value } }, projectPath),
  );

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, projectPath)) ?? {};
    const agent = objectOf(s.agent);
    setInstructions(stringOf(agent.appendSystemPrompt));
  };

  useEffect(() => {
    void load();
  }, [scope, activeProjectPath]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {t("settingsX.adv.personalizationTitle")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settingsX.adv.personalizationDesc")}
        </p>
      </div>
      <Textarea
        value={instructions}
        onChange={(e) => {
          setInstructions(e.target.value);
          schedule(e.target.value);
        }}
        onBlur={flush}
        placeholder={t("settingsX.adv.personalizationPlaceholder")}
        className="min-h-[260px] resize-y leading-relaxed"
      />
    </section>
  );
}

/**
 * Settings → 个性化 (回复语言 + 称呼画像).
 *
 * Two stable preferences injected into every conversation (main agent and
 * subagents alike): `agent.responseLanguage` (single line) and
 * `agent.userProfile` (multi-line). Auto-saves (debounced while typing,
 * flushed on blur); no Save button — same pattern as 自定义指令 above.
 */
export function ResponsePrefsSection({ scope, activeProjectPath }: ScopedProps) {
  const [language, setLanguage] = useState("");
  const [profile, setProfile] = useState("");
  // Latest values held in refs so each field's save writes both keys without
  // racing the other field's debounce.
  const languageRef = useRef("");
  const profileRef = useRef("");
  languageRef.current = language;
  profileRef.current = profile;
  const { t } = useT();
  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;

  const { schedule, flush } = useDebouncedSave(() =>
    writeSettings(
      scope,
      { agent: { responseLanguage: languageRef.current, userProfile: profileRef.current } },
      projectPath,
    ),
  );

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, projectPath)) ?? {};
    const agent = objectOf(s.agent);
    setLanguage(stringOf(agent.responseLanguage));
    setProfile(stringOf(agent.userProfile));
  };
  useEffect(() => {
    void load();
  }, [scope, activeProjectPath]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {t("settingsX.adv.responsePrefsTitle")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("settingsX.adv.responsePrefsDesc")}</p>
      </div>
      <Input
        value={language}
        onChange={(e) => {
          setLanguage(e.target.value);
          schedule(e.target.value);
        }}
        onBlur={flush}
        placeholder={t("settingsX.adv.responseLangPlaceholder")}
      />
      <Textarea
        value={profile}
        onChange={(e) => {
          setProfile(e.target.value);
          schedule(e.target.value);
        }}
        onBlur={flush}
        placeholder={t("settingsX.adv.userProfilePlaceholder")}
        className="min-h-[120px] resize-y leading-relaxed"
      />
    </section>
  );
}

/**
 * Settings → 指令文件.
 *
 * CODESHELL.md is always read; these two toggles opt into compat reading of
 * other tools' instruction files. Stored under `agent.instructions.{compatClaude,
 * compatCodex}`; absent/undefined means enabled (default true), so we treat
 * `!== false` as on.
 */
export function InstructionFilesSection({ scope, activeProjectPath }: ScopedProps) {
  const [compatClaude, setCompatClaude] = useState(true);
  const [compatCodex, setCompatCodex] = useState(true);
  const { t } = useT();
  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;
  // Mirror latest state so a toggle persists the up-to-date value of BOTH flags,
  // never a stale closure capture. writeChain serializes the fire-and-forget
  // writes so a slower earlier write can't land after — and clobber — a later one.
  const pairRef = useRef({ claude: true, codex: true });
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, projectPath)) ?? {};
    const agent = objectOf(s.agent);
    const instr = objectOf(agent.instructions);
    const claude = instr.compatClaude !== false;
    const codex = instr.compatCodex !== false;
    pairRef.current = { claude, codex };
    setCompatClaude(claude);
    setCompatCodex(codex);
  };
  useEffect(() => {
    void load();
  }, [scope, activeProjectPath]);

  // Switches persist instantly on toggle. `next` carries the full just-computed
  // pair (from pairRef, always current); writes are chained to enforce order.
  const persist = (claude: boolean, codex: boolean) => {
    pairRef.current = { claude, codex };
    writeChain.current = writeChain.current
      .catch(() => {})
      .then(() =>
        writeSettings(
          scope,
          { agent: { instructions: { compatClaude: claude, compatCodex: codex } } },
          projectPath,
        ),
      );
    void writeChain.current;
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {t("settingsX.adv.instrFilesTitle")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("settingsX.adv.instrFilesDesc")}</p>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm text-foreground">
        <span>{t("settingsX.adv.compatClaude")}</span>
        <Switch
          checked={compatClaude}
          onCheckedChange={(v) => {
            setCompatClaude(v);
            persist(v, pairRef.current.codex);
          }}
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm text-foreground">
        <span>{t("settingsX.adv.compatCodex")}</span>
        <Switch
          checked={compatCodex}
          onCheckedChange={(v) => {
            setCompatCodex(v);
            persist(pairRef.current.claude, v);
          }}
        />
      </label>
    </section>
  );
}

export function ShortcutsSection() {
  const { t } = useT();
  const rows = [
    ["⌘K", t("settingsX.adv.scCommandPalette")],
    ["⌘F", t("settingsX.adv.scSearchConv")],
    ["⌘P", t("settingsX.adv.scSearchAll")],
    ["⌘⇧N", t("settingsX.adv.scNewWindow")],
    ["Enter", t("settingsX.adv.scSend")],
    ["Shift Enter", t("settingsX.adv.scNewline")],
  ];
  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
        {t("settingsX.adv.shortcutsTitle")}
      </h3>
      <div className="rounded-md border p-2">
        {rows.map(([key, label]) => (
          <div
            className="grid grid-cols-[minmax(120px,0.35fr)_1fr] gap-3 border-b py-2 text-sm last:border-b-0"
            key={key}
          >
            <kbd>{key}</kbd>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Hooks are maintained at TWO levels — global (user, `~/.code-shell/
 * settings.json`) and per project (`<repo>/.code-shell/settings.json`).
 * Core's SettingsManager CONCATENATES `hooks` across layers (user first,
 * project after), so a global hook runs in every project alongside that
 * project's own hooks (mirrors Claude Code's user-level hooks). The page
 * first shows a "全局" row plus the project list (reusing the sidebar
 * `projects`); picking one drills into that level's hooks.
 */
export function HooksSection({ projects }: { projects: TrackedProject[] }) {
  // undefined = picker; null = global (user level); string = project cwd.
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const { t } = useT();
  const selectedProject =
    typeof selected === "string" ? (projects.find((r) => r.path === selected) ?? null) : null;

  if (selected === undefined) {
    return (
      <section className="mb-6 flex flex-col gap-3">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
          {t("settingsX.adv.hooksTitle")}
        </h3>
        <p className="m-0 text-xs text-muted-foreground">{t("settingsX.adv.hooksDesc")}</p>
        <ProjectPicker projects={projects} includeGlobal onSelect={(path) => setSelected(path)} />
      </section>
    );
  }

  return (
    <section className="mb-6 flex flex-col gap-3">
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => setSelected(undefined)}
        >
          <ArrowLeft size={14} />
          <span>{t("settingsX.adv.backToList")}</span>
        </Button>
        <span className="truncate text-sm font-medium text-foreground">
          {selected === null
            ? t("settingsX.adv.globalAllProjects")
            : selectedProject
              ? projectLabel(selectedProject)
              : selected}
        </span>
      </div>
      <ProjectHooksEditor cwd={selected} />
    </section>
  );
}

/** Hook event names a user can pick for a hand-written hook. Aligned with the
 *  events plugin hooks map to (core EVENT_NAME_MAP), plus the engine's own
 *  lifecycle events that settings hooks can legitimately register. */
const HOOK_EVENT_OPTIONS: { value: string; labelKey: string }[] = [
  { value: "pre_tool_use", labelKey: "settingsX.adv.hookEvtPreTool" },
  { value: "post_tool_use", labelKey: "settingsX.adv.hookEvtPostTool" },
  { value: "user_prompt_submit", labelKey: "settingsX.adv.hookEvtPrompt" },
  { value: "on_session_start", labelKey: "settingsX.adv.hookEvtSessStart" },
  { value: "on_session_end", labelKey: "settingsX.adv.hookEvtSessEnd" },
  { value: "pre_compact", labelKey: "settingsX.adv.hookEvtPreCompact" },
  { value: "notification", labelKey: "settingsX.adv.hookEvtNotification" },
];

/**
 * Hook 管理页 for ONE level — a project (`cwd` set) or the global user level
 * (`cwd === null`). Shows that level's hand-written hooks (with a per-entry
 * enable Switch — the `disabled` field, hot-reloaded by the engine) AND
 * plugin-provided hooks. In a project, plugin hooks get a per-hook Switch
 * too (writes `capabilityOverrides.pluginHooks[key]`, project-scoped like
 * the rest of capability control; takes effect for new sessions); the
 * global view lists them read-only. A project view also lists the global
 * hooks read-only, since both layers run together.
 */
function ProjectHooksEditor({ cwd }: { cwd: string | null }) {
  const isGlobal = cwd === null;
  const scope = isGlobal ? ("user" as const) : ("project" as const);
  const [hooks, setHooks] = useState<Array<Record<string, unknown>>>([]);
  const [globalHooks, setGlobalHooks] = useState<Array<Record<string, unknown>>>([]);
  const [pluginHooks, setPluginHooks] = useState<PluginHookEntry[]>([]);
  const [hookOverrides, setHookOverrides] = useState<Record<string, unknown>>({});
  const [event, setEvent] = useState<string>(HOOK_EVENT_OPTIONS[0]!.value);
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();
  const hookEventOptions = HOOK_EVENT_OPTIONS.map((o) => ({
    value: o.value,
    label: t(o.labelKey as Parameters<typeof t>[0]),
  }));

  const load = async () => {
    try {
      const s = (await window.codeshell.getSettings(scope, cwd ?? undefined)) ?? {};
      setHooks(Array.isArray(s.hooks) ? (s.hooks as Array<Record<string, unknown>>) : []);
      const disabledPlugins = Array.isArray(s.disabledPlugins)
        ? (s.disabledPlugins as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      setPluginHooks(await window.codeshell.listPluginHooks(disabledPlugins));
      if (!isGlobal) {
        const overrides = (
          s.capabilityOverrides as { pluginHooks?: Record<string, unknown> } | undefined
        )?.pluginHooks;
        setHookOverrides(overrides && typeof overrides === "object" ? overrides : {});
        const u = (await window.codeshell.getSettings("user")) ?? {};
        setGlobalHooks(Array.isArray(u.hooks) ? (u.hooks as Array<Record<string, unknown>>) : []);
      } else {
        setHookOverrides({});
        setGlobalHooks([]);
      }
    } catch {
      setHooks([]);
      setGlobalHooks([]);
      setPluginHooks([]);
      setHookOverrides({});
    }
  };
  useEffect(() => {
    void load();
  }, [cwd]);

  const persist = async (next: Array<Record<string, unknown>>) => {
    await writeSettings(scope, { hooks: next }, cwd ?? undefined);
    setHooks(next);
  };

  const add = async () => {
    setError(null);
    const cmd = command.trim();
    if (!cmd) {
      setError(t("settingsX.adv.fillCommand"));
      return;
    }
    await persist([...hooks, { event, command: cmd }]);
    setCommand("");
  };

  /** Per-entry enable switch — `disabled: true` keeps the entry in the file
   *  but registerSettingsHooks skips it (hot via the settings reload). */
  const toggleOwn = (index: number, enabled: boolean) => {
    const next = hooks.map((h, n) => {
      if (n !== index) return h;
      const copy = { ...h };
      if (enabled) delete copy.disabled;
      else copy.disabled = true;
      return copy;
    });
    void persist(next);
  };

  /** Per-hook plugin switch — project-scoped capabilityOverrides.pluginHooks.
   *  `null` deletes the key (= inherit/on); takes effect for new sessions. */
  const togglePluginHook = async (h: PluginHookEntry, enabled: boolean) => {
    if (isGlobal || !cwd) return;
    await writeSettings(
      "project",
      { capabilityOverrides: { pluginHooks: { [h.key]: enabled ? null : "off" } } },
      cwd,
    );
    setHookOverrides((prev) => {
      const next = { ...prev };
      if (enabled) delete next[h.key];
      else next[h.key] = "off";
      return next;
    });
  };

  const ownTitle = isGlobal ? t("settingsX.adv.globalHooks") : t("settingsX.adv.projectHooks");

  return (
    <div className="flex flex-col gap-4">
      {/* Hand-written hooks for THIS level */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">{ownTitle}</span>
        {hooks.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            {t("settingsX.adv.noHooks", { title: ownTitle })}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {hooks.map((h, i) => {
              const off = h.disabled === true;
              return (
                <li
                  className={cn(
                    "flex items-center gap-2 rounded-md border border-border px-2 py-1.5",
                    off && "opacity-60",
                  )}
                  key={i}
                >
                  <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-xs text-accent-foreground">
                    {stringOf(h.event)}
                  </span>
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {stringOf(h.command)}
                  </code>
                  <Switch
                    checked={!off}
                    onCheckedChange={(checked) => toggleOwn(i, checked)}
                    aria-label={
                      off ? t("settingsX.adv.enableHook") : t("settingsX.adv.disableHook")
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground hover:text-status-err"
                    onClick={() => void persist(hooks.filter((_, n) => n !== i))}
                  >
                    {t("settingsX.adv.delete")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* In a project: the global hooks also run here — list them read-only. */}
      {!isGlobal && globalHooks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">
            {t("settingsX.adv.globalHooksAlsoRun")}
          </span>
          <ul className="flex flex-col gap-1">
            {globalHooks.map((h, i) => (
              <li
                className={cn(
                  "flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5",
                  h.disabled === true && "opacity-60",
                )}
                key={i}
              >
                <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-xs text-accent-foreground">
                  {stringOf(h.event)}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {stringOf(h.command)}
                </code>
                <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  {h.disabled === true
                    ? t("settingsX.adv.globalDisabledBadge")
                    : t("settingsX.adv.globalBadge")}
                </span>
              </li>
            ))}
          </ul>
          <span className="text-xs text-muted-foreground">
            {t("settingsX.adv.editGlobalHooksHint")}
          </span>
        </div>
      )}

      {/* Add a hand-written hook — event dropdown + command input (replaces the
          old raw-JSON textarea). */}
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-muted-foreground">{t("settingsX.adv.addHook")}</span>
        <div className="flex items-end gap-2">
          <div className="w-56 shrink-0">
            <Select value={event} onChange={setEvent} options={hookEventOptions} />
          </div>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={t("settingsX.adv.hookCmdPlaceholder")}
            className="font-mono text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <Button variant="solid" className="w-fit shrink-0" onClick={() => void add()}>
            {t("settingsX.adv.add")}
          </Button>
        </div>
        {error && <div className="text-sm text-status-err">{error}</div>}
      </div>

      {/* Plugin-provided hooks — labelled by owner plugin (MCP page's
          owner-stamp pattern). In a project each hook gets its own Switch
          (capabilityOverrides.pluginHooks); the global view is read-only. */}
      {pluginHooks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">
            {t("settingsX.adv.pluginProvidedHooks")}
          </span>
          <ul className="flex flex-col gap-1">
            {pluginHooks.map((h, i) => {
              const overrideOff = hookOverrides[h.key] === "off";
              const off = h.disabled || overrideOff;
              return (
                <li
                  className={cn(
                    "flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5",
                    off && "opacity-60",
                  )}
                  key={`${h.plugin}-${h.rawEvent}-${i}`}
                >
                  <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-xs text-accent-foreground">
                    {h.event}
                  </span>
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {h.command}
                  </code>
                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {t("settingsX.adv.providedByPluginShort", { plugin: h.plugin })}
                    {h.disabled ? t("settingsX.adv.pluginDisabledSuffix") : ""}
                  </span>
                  {!isGlobal && (
                    <Switch
                      checked={!off}
                      disabled={h.disabled}
                      onCheckedChange={(checked) => void togglePluginHook(h, checked)}
                      aria-label={
                        off
                          ? t("settingsX.adv.enablePluginHook")
                          : t("settingsX.adv.disablePluginHook")
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <span className="text-xs text-muted-foreground">
            {isGlobal
              ? t("settingsX.adv.pluginHookGlobalHint")
              : t("settingsX.adv.pluginHookProjectHint")}
          </span>
        </div>
      )}
    </div>
  );
}

export function ConnectionsSection(props: ScopedProps) {
  return <ConnectionsPanel {...props} />;
}

export function GitSection() {
  const [prefs, setPrefs] = useState<GitPrefs>(() => loadGitPrefs());
  const lastPersistedBranchPrefix = useRef(prefs.branchPrefix);
  const branchPrefixRequestId = useRef(0);
  const [branchPrefixError, setBranchPrefixError] = useState<string | null>(null);
  // git.path: the user-configured git binary (machine-level, user scope). Lives
  // in settings.json (not the localStorage GitPrefs) because core reads it to
  // resolve git for marketplace clones / worktrees when a GUI launch didn't
  // inherit PATH. null check status: undefined=unchecked, true/false=probed.
  const [gitPath, setGitPath] = useState("");
  const [gitOk, setGitOk] = useState<boolean | undefined>(undefined);
  const [gitInstallUrl, setGitInstallUrl] = useState("https://git-scm.com/downloads");
  const [checking, setChecking] = useState(false);
  const { t } = useT();

  useEffect(() => {
    setPrefs(loadGitPrefs());
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = (await window.codeshell.getSettings("user")) ?? {};
      if (cancelled) return;
      const savedPath = stringOf(objectOf(s.git).path);
      const savedWorktreePrefix = stringOf(objectOf(s.worktree).branchPrefix);
      if (savedWorktreePrefix) {
        const nextPrefs = { ...loadGitPrefs(), branchPrefix: savedWorktreePrefix };
        lastPersistedBranchPrefix.current = savedWorktreePrefix;
        setPrefs(nextPrefs);
        saveGitPrefs(nextPrefs);
        void window.codeshell.setGitPrefs?.(nextPrefs);
      }
      setGitPath(savedPath);
      // Auto-probe git availability on mount so the result is shown right away
      // and survives leaving/returning to settings — `gitOk` is in-memory state
      // that resets on unmount, so without this the user had to re-click 检查
      // every time (the "检测了需要保留/回显" complaint). When main can resolve
      // the actual binary path, persist it so GUI launches that later miss PATH
      // still use the detected git.
      setChecking(true);
      try {
        const r = await window.codeshell.checkGit();
        if (!cancelled) {
          setGitOk(r.available);
          if (r.installUrl) setGitInstallUrl(r.installUrl);
          if (r.available) await applyDetectedGitPath(r.path);
        }
      } catch {
        if (!cancelled) setGitOk(false);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    schedule: scheduleGitPath,
    flush: flushGitPath,
    cancel: cancelGitPath,
  } = useDebouncedSave((value) => writeSettings("user", { git: { path: value } }));

  const applyDetectedGitPath = async (path: string | undefined): Promise<void> => {
    const detected = path?.trim();
    if (!detected) return;
    setGitPath(detected);
    await writeSettings("user", { git: { path: detected } });
  };

  const checkGit = async (pathOverride?: string) => {
    const pathToCheck = pathOverride ?? gitPath;
    setChecking(true);
    try {
      if (pathOverride === undefined) flushGitPath();
      else cancelGitPath();
      await writeSettings("user", { git: { path: pathToCheck } });
      const r = await window.codeshell.checkGit();
      setGitOk(r.available);
      if (r.installUrl) setGitInstallUrl(r.installUrl);
      if (r.available) await applyDetectedGitPath(r.path);
    } catch {
      setGitOk(false);
    } finally {
      setChecking(false);
    }
  };

  const pickGit = async () => {
    const picked = await window.codeshell.pickGitBinary?.();
    if (!picked) return;
    setGitPath(picked);
    setGitOk(undefined);
    // 选完立刻验证这个路径到底是不是能用的 git,免得用户选错文件还以为成了。
    await checkGit(picked);
  };

  const update = <K extends keyof GitPrefs>(key: K, value: GitPrefs[K]) => {
    if (key === "branchPrefix") {
      updateBranchPrefix(String(value));
      return;
    }
    setPrefs((c) => {
      const next = { ...c, [key]: value };
      const persisted = { ...next, branchPrefix: lastPersistedBranchPrefix.current };
      saveGitPrefs(persisted);
      void window.codeshell.setGitPrefs?.(persisted);
      return next;
    });
  };

  const updateBranchPrefix = (value: string): void => {
    const requestId = ++branchPrefixRequestId.current;
    const normalized = normalizeBranchPrefix(value);
    setPrefs((c) => ({ ...c, branchPrefix: value }));
    setBranchPrefixError(null);
    void (async () => {
      try {
        await writeSettings("user", {
          worktree: { branchPrefix: normalized },
        });
        if (branchPrefixRequestId.current !== requestId) return;
        lastPersistedBranchPrefix.current = normalized;
        setPrefs((c) => {
          const next = { ...c, branchPrefix: normalized };
          saveGitPrefs(next);
          void window.codeshell.setGitPrefs?.(next);
          return next;
        });
        setBranchPrefixError(null);
      } catch (error) {
        if (branchPrefixRequestId.current !== requestId) return;
        setBranchPrefixError(error instanceof Error ? error.message : String(error));
      }
    })();
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        <GitRowShell
          title={t("settingsX.adv.gitPathTitle")}
          help={t("settingsX.adv.gitPathHelp")}
          control={
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <input
                  className="rounded-sm border bg-transparent px-2 py-1.5 text-sm"
                  value={gitPath}
                  placeholder={t("settingsX.adv.gitPathPlaceholder")}
                  onChange={(e) => {
                    setGitPath(e.target.value);
                    setGitOk(undefined);
                    scheduleGitPath(e.target.value);
                  }}
                  onBlur={flushGitPath}
                />
                <Button size="sm" variant="outline" onClick={() => void pickGit()}>
                  {t("settingsX.adv.pick")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={checking}
                  onClick={() => void checkGit()}
                >
                  {checking ? t("settingsX.adv.checking") : t("settingsX.adv.check")}
                </Button>
                {gitOk === true && (
                  <span className="text-xs text-status-ok">{t("settingsX.adv.gitAvailable")}</span>
                )}
                {gitOk === false && (
                  <span className="text-xs text-status-err">{t("settingsX.adv.gitNotFound")}</span>
                )}
              </div>
              {gitOk === false && (
                <span className="max-w-xl text-xs text-muted-foreground">
                  {t("settingsX.adv.gitInstallHint")}{" "}
                  <a className="underline" href={gitInstallUrl} target="_blank" rel="noreferrer">
                    {t("settingsX.adv.gitDownload")}
                  </a>
                </span>
              )}
            </div>
          }
        />
        <GitRowShell
          title={t("settingsX.adv.branchPrefixTitle")}
          help={t("settingsX.adv.branchPrefixHelp")}
          control={
            <div className="flex flex-col gap-1">
              <input
                className="rounded-sm border bg-transparent px-2 py-1.5 text-sm"
                value={prefs.branchPrefix}
                placeholder={DEFAULT_GIT_PREFS.branchPrefix}
                aria-invalid={branchPrefixError ? true : undefined}
                onChange={(e) => update("branchPrefix", e.target.value)}
              />
              {branchPrefixError && (
                <span className="max-w-64 text-xs text-status-err" role="alert">
                  {branchPrefixError}
                </span>
              )}
            </div>
          }
        />
        <GitRowShell
          title={t("settingsX.adv.autoDeleteTitle")}
          help={t("settingsX.adv.autoDeleteHelp")}
          control={
            <Switch
              checked={prefs.autoDeleteWorktrees}
              onCheckedChange={(v) => update("autoDeleteWorktrees", v)}
            />
          }
        />
        <GitRowShell
          title={t("settingsX.adv.graceTitle")}
          help={t("settingsX.adv.graceHelp")}
          control={
            <div className="flex items-center gap-2">
              <input
                className="w-24 rounded-sm border bg-transparent px-2 py-1.5 text-sm"
                type="number"
                value={prefs.autoDeleteWorktreesGraceMins}
                min={1}
                max={60 * 24 * 365}
                disabled={!prefs.autoDeleteWorktrees}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  if (Number.isFinite(n) && n >= 1) update("autoDeleteWorktreesGraceMins", n);
                }}
              />
              <span className="text-xs text-muted-foreground">{t("settingsX.adv.minutes")}</span>
            </div>
          }
        />
      </ul>
    </section>
  );
}

function GitRowShell({
  title,
  help,
  control,
}: {
  title: string;
  help?: string;
  control: React.ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {help && <div className="mt-1 text-xs text-muted-foreground">{help}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </li>
  );
}

type LocalEnvPlatform = "default" | "macos" | "linux" | "windows";

const LOCAL_ENV_TABS: Array<{ id: LocalEnvPlatform; label: string }> = [
  { id: "default", label: "默认" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
  { id: "windows", label: "Windows" },
];

const EMPTY_SCRIPTS: Record<LocalEnvPlatform, string> = {
  default: "",
  macos: "",
  linux: "",
  windows: "",
};

/**
 * Local environment is PROJECT-scoped (setup/cleanup scripts + env + sandbox
 * boundary live in a specific repo's `.code-shell/settings.json`). Like 钩子,
 * the page first shows a project list; clicking one drills into that project's
 * environment editor. This replaces the old "silently follow activeProjectPath"
 * behavior where the user couldn't tell (or switch) which project they edited.
 */
/**
 * Global environment-variable editor (top-level `env`, user scope). This is the
 * canonical home for API keys (e.g. OPENAI_API_KEY) that a skill's script reads:
 * configure once here and every project's Bash tool / background shells inherit
 * it. A project's own `本地环境` env (and its top-level env) override these.
 * Mirrors Claude Code's `env` field. Reuses parseEnvText/envTextOf so the
 * KEY=VALUE wire format matches the project editor exactly.
 */
function GlobalEnvEditor() {
  const [envText, setEnvText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { t } = useT();

  const load = async () => {
    const s = (await window.codeshell.getSettings("user")) ?? {};
    setEnvText(envTextOf(s.env));
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await writeSettings("user", { env: parseEnvText(envText) });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
        {t("settingsX.adv.globalEnvTitle")}
      </h3>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.adv.globalEnvDesc")}</p>
      <label className="flex flex-col gap-1.5">
        <Textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={"OPENAI_API_KEY=sk-...\nFAL_KEY=..."}
          className="min-h-[120px] resize-y font-mono text-sm"
        />
        <span className="mt-1 text-xs text-muted-foreground">
          {t("settingsX.adv.globalEnvHint")}
        </span>
      </label>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="solid" className="w-fit" onClick={() => void save()} disabled={saving}>
          {saving ? t("settingsX.adv.saving") : t("settingsX.adv.saveGlobalEnv")}
        </Button>
        {savedAt && (
          <span className="text-sm text-status-ok">
            {t("settingsX.adv.savedAt", {
              time: new Date(savedAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </span>
        )}
      </div>
    </section>
  );
}

export function EnvironmentSection({ projects }: { projects: TrackedProject[] }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const { t } = useT();
  const selectedProject = projects.find((r) => r.path === selectedPath) ?? null;

  if (!selectedPath) {
    return (
      <>
        <GlobalEnvEditor />
        <section className="mb-6 flex flex-col gap-3">
          <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
            {t("settingsX.adv.perProjectTitle")}
          </h3>
          <p className="m-0 text-xs text-muted-foreground">{t("settingsX.adv.perProjectDesc")}</p>
          <ProjectPicker projects={projects} onSelect={(path) => setSelectedPath(path)} />
        </section>
      </>
    );
  }

  return (
    <section className="mb-6 flex flex-col gap-3">
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => setSelectedPath(null)}
        >
          <ArrowLeft size={14} />
          <span>{t("settingsX.adv.backToProjectList")}</span>
        </Button>
        <span className="truncate text-sm font-medium text-foreground">
          {selectedProject ? projectLabel(selectedProject) : selectedPath}
        </span>
      </div>
      <ProjectEnvEditor cwd={selectedPath} />
    </section>
  );
}

/** Local-environment editor for a single project (cwd is a concrete repo path). */
function ProjectEnvEditor({ cwd }: { cwd: string }) {
  const targetScope = "project" as const;
  const projectName = pathBasename(cwd);
  const [name, setName] = useState(projectName);
  const [setupTab, setSetupTab] = useState<LocalEnvPlatform>("default");
  // cleanupTab 暂时移除:清理脚本 UI 已隐藏(cleanup 未接)。恢复 UI 时一并恢复此行。
  const [setupScripts, setSetupScripts] = useState<Record<LocalEnvPlatform, string>>(EMPTY_SCRIPTS);
  const [cleanupScripts, setCleanupScripts] =
    useState<Record<LocalEnvPlatform, string>>(EMPTY_SCRIPTS);
  const [envText, setEnvText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { t } = useT();

  const load = async () => {
    const s = (await window.codeshell.getSettings(targetScope, cwd)) ?? {};
    const localEnvironment = objectOf(s.localEnvironment);
    setName(stringOf(localEnvironment.name) || projectName);
    setSetupScripts(scriptMapOf(localEnvironment.setupScripts));
    setCleanupScripts(scriptMapOf(localEnvironment.cleanupScripts));
    setEnvText(envTextOf(localEnvironment.env));
  };
  useEffect(() => {
    void load();
  }, [cwd]);

  const save = async () => {
    setSaving(true);
    try {
      await writeSettings(
        targetScope,
        {
          localEnvironment: {
            name: name.trim() || projectName,
            setupScripts,
            cleanupScripts,
            env: parseEnvText(envText),
          },
        },
        cwd,
      );
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const hint = "mt-1 text-xs text-muted-foreground";
  const field = "flex flex-col gap-1.5";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
        <Folder size={18} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <strong className="block text-sm font-medium text-foreground">{projectName}</strong>
          <span className="block break-all text-sm text-muted-foreground">{cwd}</span>
        </div>
      </div>

      <label className={`${field} max-w-[420px]`}>
        <span className="text-sm text-muted-foreground">{t("settingsX.adv.fieldName")}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={projectName} />
      </label>

      <LocalScriptEditor
        title={t("settingsX.adv.setupScriptTitle")}
        scopeLabel={t("settingsX.adv.worktreeOnly")}
        help={t("settingsX.adv.setupScriptHelp")}
        activeTab={setupTab}
        onTabChange={setSetupTab}
        scripts={setupScripts}
        onScriptChange={(tab, value) => setSetupScripts((prev) => ({ ...prev, [tab]: value }))}
        placeholder={"pip install -r requirements.txt\nnpm install\n./run/setup.sh"}
      />

      {/* 清理脚本 UI 暂时隐藏:cleanup 当前不自动收尾运行(决策未接),展示出来会
          误导用户以为配了就生效。state(cleanupScripts)+ 保存逻辑保留,接上 cleanup
          功能后直接恢复这段 <LocalScriptEditor title="清理脚本" …/> 即可,不丢已存数据。
          见 TODO-feedback.md「清理脚本(cleanup)未接但 UI 可配」。 */}

      <label className={field}>
        <span className="text-sm text-muted-foreground">{t("settingsX.adv.varsAllProject")}</span>
        <Textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={"KEY=value\nNODE_ENV=development"}
          className="min-h-[120px] resize-y font-mono text-sm"
        />
        <span className={hint}>{t("settingsX.adv.varsHint")}</span>
      </label>

      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        {t("settingsX.adv.sandboxMovedHint")}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="solid" className="w-fit" onClick={() => void save()} disabled={saving}>
          {saving ? t("settingsX.adv.saving") : t("settingsX.adv.saveLocalEnv")}
        </Button>
        {savedAt && (
          <span className="text-sm text-status-ok">
            {t("settingsX.adv.savedAt", {
              time: new Date(savedAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </span>
        )}
      </div>
    </div>
  );
}

function LocalScriptEditor({
  title,
  help,
  scopeLabel,
  activeTab,
  onTabChange,
  scripts,
  onScriptChange,
  placeholder,
}: {
  title: string;
  help: string;
  /** Optional scope badge (e.g. "仅 worktree 生效") to distinguish this from
   *  the全项目-scoped 变量/沙箱 sections. */
  scopeLabel?: string;
  activeTab: LocalEnvPlatform;
  onTabChange: (tab: LocalEnvPlatform) => void;
  scripts: Record<LocalEnvPlatform, string>;
  onScriptChange: (tab: LocalEnvPlatform, value: string) => void;
  placeholder: string;
}) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h4 className="m-0 flex items-center gap-2 text-sm font-semibold text-foreground">
            {title}
            {scopeLabel && (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                {scopeLabel}
              </span>
            )}
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">{help}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={title}>
          {LOCAL_ENV_TABS.map((tab) => (
            <Button
              key={tab.id}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={activeTab === tab.id}
              className={cn(activeTab === tab.id && "bg-accent font-semibold text-foreground")}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.id === "default" ? t("settingsX.adv.localEnvDefault") : tab.label}
            </Button>
          ))}
        </div>
      </div>
      <Textarea
        value={scripts[activeTab]}
        onChange={(e) => onScriptChange(activeTab, e.target.value)}
        placeholder={placeholder}
        className="min-h-[180px] resize-y font-mono text-sm"
      />
    </div>
  );
}

export function ToggleCapabilitySection({
  scope,
  activeProjectPath,
  settingKey,
  title,
  description,
}: ScopedProps & { settingKey: "browser" | "computer"; title: string; description: string }) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const { t } = useT();
  const toast = useToast();
  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, projectPath)) ?? {};
    setEnabled(objectOf(s[settingKey]).enabled === true);
  };
  useEffect(() => {
    void load();
  }, [scope, activeProjectPath, settingKey]);

  const save = async (next: boolean) => {
    const prev = enabled;
    setEnabled(next); // optimistic
    setSaving(true);
    try {
      await writeSettings(scope, { [settingKey]: { enabled: next } }, projectPath);
    } catch (e) {
      // Write failed — revert the optimistic flip and surface it, otherwise the
      // toggle reads "enabled" while disk stays unchanged (silent desync until remount).
      setEnabled(prev);
      toast({
        message: `${t("settingsX.adv.toggleSaveFailed")}: ${e instanceof Error ? e.message : String(e)}`,
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">{title}</h3>
      <p className="m-0 text-xs text-muted-foreground">{description}</p>
      <label className="flex items-center gap-2 text-sm">
        <span>{enabled ? t("settingsX.adv.enabled") : t("settingsX.adv.disabled")}</span>
        <Switch checked={enabled} disabled={saving} onCheckedChange={(next) => void save(next)} />
      </label>
    </section>
  );
}

/**
 * Image clarity settings — a provider-agnostic level (low / standard /
 * high) that the renderer turns into a long-edge downscale before send,
 * so BOTH OpenAI and Claude save tokens. On the OpenAI path it also maps
 * to the wire `detail` hint; on the Anthropic path the saving comes
 * entirely from the renderer downscale.
 *
 * We surface it on the user-level page because the active model can
 * switch mid-session and we'd rather have one place to control it than
 * per-call args.
 */
export function ImageSettingsSection({ scope, activeProjectPath }: ScopedProps) {
  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;
  const [detail, setDetail] = useState<"low" | "standard" | "high" | "">("");
  const [saving, setSaving] = useState(false);
  const { t } = useT();

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, projectPath)) ?? {};
    const images = objectOf(s.images);
    // Migrate legacy "original" → "high".
    const d = images.detail === "original" ? "high" : images.detail;
    setDetail(d === "low" || d === "standard" || d === "high" ? d : "");
  };
  useEffect(() => {
    void load();
  }, [scope, activeProjectPath]);

  const save = async (next: "low" | "standard" | "high" | ""): Promise<void> => {
    setDetail(next);
    setSaving(true);
    try {
      const current = objectOf((await window.codeshell.getSettings(scope, projectPath))?.images);
      const nextImages = next ? { ...current, detail: next } : { ...current, detail: undefined };
      await writeSettings(scope, { images: nextImages }, projectPath);
    } finally {
      setSaving(false);
    }
  };

  const options: Array<{ id: "low" | "standard" | "high" | ""; label: string; help: string }> = [
    { id: "", label: t("settingsX.adv.imgDefault"), help: t("settingsX.adv.imgDefaultHelp") },
    { id: "low", label: t("settingsX.adv.imgLow"), help: t("settingsX.adv.imgLowHelp") },
    {
      id: "standard",
      label: t("settingsX.adv.imgStandard"),
      help: t("settingsX.adv.imgStandardHelp"),
    },
    { id: "high", label: t("settingsX.adv.imgHigh"), help: t("settingsX.adv.imgHighHelp") },
  ];

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
        {t("settingsX.adv.imageClarityTitle")}
      </h3>
      <p className="m-0 text-xs text-muted-foreground">
        {t("settingsX.adv.imageClarityDesc")}
        {scope === "user"
          ? t("settingsX.adv.imageClarityDescGlobal")
          : t("settingsX.adv.imageClarityDescProject")}
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {options.map((o) => (
          <button
            key={o.id || "default"}
            type="button"
            className={cn(
              "flex cursor-pointer flex-col items-start gap-1 rounded-md border bg-transparent p-3 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
              detail === o.id && "border-primary bg-primary/10 ring-1 ring-primary/30",
            )}
            disabled={saving}
            onClick={() => void save(o.id)}
          >
            <span className="text-sm font-medium text-foreground">{o.label}</span>
            <span className="text-xs text-muted-foreground">{o.help}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function ArchivedConversationsSection({
  projects,
  sessionIndices,
  onRestore,
  onDelete,
}: {
  projects: TrackedProject[];
  sessionIndices: Record<string, SessionIndex>;
  onRestore: (projectId: string | null, sessionId: string) => void;
  onDelete: (projectId: string | null, sessionId: string) => void;
}) {
  const { t } = useT();
  const rows = useMemo(() => {
    const projectMap = new Map(projects.map((r) => [r.id, projectLabel(r)]));
    return Object.entries(sessionIndices)
      .flatMap(([key, idx]) => {
        const projectId = key === NO_REPO_KEY ? null : key;
        // A deleted project is gone from `projects`, so fall back to the label
        // stamped at delete time (deletedProjectLabel) before giving up to
        // "未知项目" — keeps archived sessions named after their original project.
        const project = projectId
          ? (projectMap.get(projectId) ??
            idx.deletedProjectLabel ??
            t("settingsX.adv.unknownProject"))
          : t("settingsX.adv.noRepoConv");
        return idx.sessions
          .filter((s) => s.archived)
          .map((s) => ({ projectId, project, session: s }));
      })
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  }, [projects, sessionIndices, t]);

  const confirm = useConfirm();

  const removeOne = (projectId: string | null, sessionId: string, title: string): void => {
    void confirm({
      title: t("settingsX.adv.confirmDeleteTitle"),
      message: t("settingsX.adv.confirmDeleteMsg", { title: truncateTitle(title, 28) }),
      detail: t("settingsX.adv.irreversible"),
      confirmLabel: t("settingsX.adv.delete"),
      destructive: true,
    }).then((ok) => {
      if (ok) onDelete(projectId, sessionId);
    });
  };

  const removeAll = (): void => {
    if (rows.length === 0) return;
    void confirm({
      title: t("settingsX.adv.confirmClearAllTitle"),
      message: t("settingsX.adv.confirmClearAllMsg", { count: rows.length }),
      detail: t("settingsX.adv.irreversible"),
      confirmLabel: t("settingsX.adv.deleteAll"),
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      for (const row of rows) onDelete(row.projectId, row.session.id);
    });
  };

  return (
    <section className="rounded-md border p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          className="h-8 px-3 text-xs text-status-err hover:text-status-err"
          onClick={removeAll}
          disabled={rows.length === 0}
        >
          {t("settingsX.adv.deleteAll")}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="p-4 text-center text-sm text-muted-foreground">
          {t("settingsX.adv.noArchived")}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ projectId, project, session }) => (
            <li
              key={`${projectId ?? NO_REPO_KEY}:${session.id}`}
              className="flex items-center gap-3 rounded-md border p-3"
            >
              <div className="min-w-0 flex flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {session.title}
                </span>
                <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="tabular-nums">{formatArchivedTime(session.updatedAt)}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="truncate">{project}</span>
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="h-7 w-7 text-muted-foreground hover:text-status-err"
                  onClick={() => removeOne(projectId, session.id, session.title)}
                  title={t("settingsX.adv.permDelete")}
                  aria-label={t("settingsX.adv.permDelete")}
                >
                  <Trash2 size={14} />
                </button>
                <button
                  type="button"
                  className="h-7 px-2 text-xs"
                  onClick={() => onRestore(projectId, session.id)}
                  title={t("settingsX.adv.unarchive")}
                >
                  {t("settingsX.adv.unarchive")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatArchivedTime(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return translate(loadUILanguage(), "settingsX.adv.archivedTime", { yyyy, m, day, hh, mm });
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function scriptMapOf(value: unknown): Record<LocalEnvPlatform, string> {
  const obj = objectOf(value);
  return {
    default: stringOf(obj.default),
    macos: stringOf(obj.macos),
    linux: stringOf(obj.linux),
    windows: stringOf(obj.windows),
  };
}

function envTextOf(value: unknown): string {
  return Object.entries(objectOf(value))
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

type MobileDevice = {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
};

/** Compact zh relative time for the device list ("刚刚 / 3 分钟前 / 2 天前"). */
function relativeTime(ts?: number): string {
  const lang = loadUILanguage();
  if (!ts) return translate(lang, "settingsX.adv.neverConnected");
  const diff = Date.now() - ts;
  if (diff < 60_000) return translate(lang, "settingsX.adv.justNow");
  const min = Math.floor(diff / 60_000);
  if (min < 60) return translate(lang, "settingsX.adv.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate(lang, "settingsX.adv.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  return translate(lang, "settingsX.adv.daysAgo", { n: day });
}

/**
 * Mobile Web Remote — start/stop a LAN HTTP/WebSocket host so a trusted phone
 * can drive CodeShell chat + approvals. Off by default; no public relay. The
 * pairing URL is one-time (10-min TTL) and must be opened on the phone.
 */
export function MobileRemoteSection() {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const { t } = useT();
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [status, setStatus] = useState<{
    running: boolean;
    url?: string;
    mode?: MobileRemoteMode;
    tunnelRunning?: boolean;
    tunnelConnected?: boolean;
  }>({ running: false });
  const [pairingUrl, setPairingUrl] = useState<string | undefined>();
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>();
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [busy, setBusy] = useState(false);
  // ── Public tunnel mode ──
  const [mode, setModeState] = useState<MobileRemoteMode>(() => loadMobileRemoteMode());
  const [passcodeSet, setPasscodeSet] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState("");
  const [cloudflaredInstalled, setCloudflaredInstalled] = useState(true);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [tunnelState, setTunnelState] = useState<"connected" | "disconnected" | null>(null);

  const setMode = useCallback((next: MobileRemoteMode) => {
    setModeState(next);
    saveMobileRemoteMode(next);
  }, []);

  // Render the pairing URL as a QR code locally (no external service — the
  // token is a secret and must never leave the machine).
  useEffect(() => {
    if (!pairingUrl) {
      setQrDataUrl(undefined);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(pairingUrl, { width: 220, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [pairingUrl]);

  const refresh = useCallback(async () => {
    const next = await window.codeshell.mobileRemote.status();
    setStatus(next);
    if (next.running && next.mode) {
      setMode(next.mode);
    }
    if (next.running && next.mode === "tunnel") {
      setTunnelState(next.tunnelConnected ? "connected" : "disconnected");
    } else if (!next.running || next.mode === "lan") {
      setTunnelState(null);
    }
    setDevices(await window.codeshell.mobileRemote.listDevices());
    setPasscodeSet((await window.codeshell.mobileRemote.passcodeStatus()).isSet);
    setCloudflaredInstalled(await window.codeshell.mobileRemote.cloudflaredInstalled());
    setOnlineIds(await window.codeshell.mobileRemote.onlineDevices());
    return next;
  }, [setMode]);

  // Regenerate the QR on the already-running host. pairingUrl is renderer-local
  // state lost on a settings-page remount, so after navigating back the host is
  // still running but the QR is gone — this re-mints one without a restart.
  const regenPairing = useCallback(async () => {
    try {
      const res = await window.codeshell.mobileRemote.pairingUrl();
      setPairingUrl(res.pairingUrl);
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : t("settingsX.adv.genQrFailed"),
        variant: "error",
      });
    }
  }, [toast, t]);

  useEffect(() => {
    void (async () => {
      const st = await refresh();
      // Host still running after a remount but the QR is renderer-local state
      // and was lost → re-mint one so the page isn't stuck with no way back.
      if (st?.running && (st.mode !== "tunnel" || st.tunnelConnected)) void regenPairing();
    })();
  }, [refresh, regenPairing]);

  // Live download progress + tunnel status pushed from main.
  useEffect(() => {
    const offProgress = window.codeshell.mobileRemote.onDownloadProgress((pct) =>
      setDownloadPct(pct),
    );
    const offTunnel = window.codeshell.mobileRemote.onTunnelStatus(({ status: s }) => {
      if (s === "connected") {
        setTunnelState("connected");
        void refresh();
        if (!pairingUrl) void regenPairing();
      } else if (s === "disconnected") {
        // Address invalidated: clear the QR and prompt a re-open.
        setTunnelState("disconnected");
        setPairingUrl(undefined);
        toast({ message: t("settingsX.adv.tunnelDisconnectedToast"), variant: "error" });
        void refresh();
      }
    });
    const offOnline = window.codeshell.mobileRemote.onOnlineChange((ids) => setOnlineIds(ids));
    return () => {
      offProgress();
      offTunnel();
      offOnline();
    };
  }, [pairingUrl, refresh, regenPairing, toast, t]);

  async function start() {
    setBusy(true);
    setTunnelState(null);
    try {
      const res = await window.codeshell.mobileRemote.start({ mode });
      setPairingUrl(res.pairingUrl);
      if (mode === "tunnel") setTunnelState("connected");
      await refresh();
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : t("settingsX.adv.startFailed"),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await window.codeshell.mobileRemote.stop();
      setPairingUrl(undefined);
      setTunnelState(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function savePasscode() {
    if (passcodeInput.length < 4) {
      toast({ message: t("settingsX.adv.passcodeMin"), variant: "error" });
      return;
    }
    setBusy(true);
    try {
      await window.codeshell.mobileRemote.setPasscode(passcodeInput);
      setPasscodeInput("");
      setPasscodeSet(true);
      toast({ message: t("settingsX.adv.passcodeSaved"), variant: "success" });
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : t("settingsX.adv.savePasscodeFailed"),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function downloadCloudflared() {
    setDownloadPct(0);
    try {
      await window.codeshell.mobileRemote.downloadCloudflared();
      setCloudflaredInstalled(true);
      toast({ message: t("settingsX.adv.cloudflaredDownloaded"), variant: "success" });
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : t("settingsX.adv.downloadFailed"),
        variant: "error",
      });
    } finally {
      setDownloadPct(null);
    }
  }

  async function removeDevice(device: MobileDevice) {
    const ok = await confirm({
      title: t("settingsX.adv.deleteDeviceTitle"),
      message: t("settingsX.adv.deleteDeviceMsg", { name: device.name }),
      confirmLabel: t("settingsX.adv.delete"),
      destructive: true,
    });
    if (!ok) return;
    await window.codeshell.mobileRemote.removeDevice(device.id);
    await refresh();
    toast({ message: t("settingsX.adv.deviceDeleted"), variant: "success" });
  }

  async function renameDevice(device: MobileDevice) {
    const name = await prompt({
      title: t("settingsX.adv.renameDeviceTitle"),
      message: t("settingsX.adv.renameDeviceMsg"),
      defaultValue: device.name,
      confirmLabel: t("settingsX.adv.save"),
    });
    if (name == null) return;
    const ok = await window.codeshell.mobileRemote.renameDevice(device.id, name);
    if (!ok) {
      toast({ message: t("settingsX.adv.nameInvalid"), variant: "error" });
      return;
    }
    await refresh();
  }

  async function changePasscode() {
    const next = await prompt({
      title: passcodeSet
        ? t("settingsX.adv.changePasscodeTitle")
        : t("settingsX.adv.setPasscodeTitle"),
      message: t("settingsX.adv.changePasscodeMsg"),
      placeholder: t("settingsX.adv.newPasscodePlaceholder"),
      confirmLabel: t("settingsX.adv.save"),
    });
    if (next == null) return;
    try {
      await window.codeshell.mobileRemote.setPasscode(next);
      await refresh();
      toast({ message: t("settingsX.adv.passcodeUpdated"), variant: "success" });
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : t("settingsX.adv.setPasscodeFailed"),
        variant: "error",
      });
    }
  }

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
        {t("settingsX.adv.mobileTitle")}
      </h3>
      <p className="text-sm text-muted-foreground">{t("settingsX.adv.mobileDesc")}</p>

      {/* 模式选择:局域网 / 公网(隧道) */}
      <div className="mt-3 max-w-xs">
        <Select
          value={mode}
          onChange={(v) => setMode(v === "tunnel" ? "tunnel" : "lan")}
          disabled={busy || status.running}
          options={[
            { value: "lan", label: t("settingsX.adv.modeLan") },
            { value: "tunnel", label: t("settingsX.adv.modeTunnel") },
          ]}
        />
      </div>

      {mode === "tunnel" ? (
        <div className="mt-3 space-y-3 rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("settingsX.adv.tunnelDesc")}</p>

          {/* 访问口令 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {passcodeSet
                ? t("settingsX.adv.passcodeLabelSet")
                : t("settingsX.adv.passcodeLabelUnset")}
            </label>
            <div className="flex gap-2">
              <Input
                type="password"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                placeholder={
                  passcodeSet
                    ? t("settingsX.adv.passcodePlaceholderReset")
                    : t("settingsX.adv.passcodePlaceholderNew")
                }
                className="max-w-xs"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void savePasscode()}
                disabled={busy || passcodeInput.length < 4}
              >
                {passcodeSet ? t("settingsX.adv.resetPasscode") : t("settingsX.adv.setPasscode")}
              </Button>
            </div>
            {!passcodeSet ? (
              <p className="text-xs text-status-warn">{t("settingsX.adv.passcodeRequiredWarn")}</p>
            ) : null}
          </div>

          {/* cloudflared 下载 */}
          {!cloudflaredInstalled ? (
            <div className="space-y-1.5">
              <Button
                type="button"
                variant="outline"
                onClick={() => void downloadCloudflared()}
                disabled={downloadPct !== null}
              >
                {downloadPct !== null
                  ? t("settingsX.adv.downloadingPct", { pct: downloadPct })
                  : t("settingsX.adv.downloadCloudflared")}
              </Button>
              {downloadPct !== null ? (
                <div className="h-1.5 w-full max-w-xs overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${downloadPct}%` }}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("settingsX.adv.cloudflaredReady")}</p>
          )}
        </div>
      ) : null}

      <div className="flex gap-2 mt-3">
        <Button
          type="button"
          onClick={start}
          disabled={busy || status.running || (mode === "tunnel" && !passcodeSet)}
        >
          {mode === "tunnel" ? t("settingsX.adv.startTunnel") : t("settingsX.adv.startMobile")}
        </Button>
        <Button type="button" variant="outline" onClick={stop} disabled={busy || !status.running}>
          {t("settingsX.adv.stop")}
        </Button>
      </div>
      <p className="text-sm mt-2">
        {status.running
          ? t("settingsX.adv.runningAt", { url: status.url ?? "" })
          : t("settingsX.adv.stopped")}
      </p>
      {mode === "tunnel" && tunnelState ? (
        <p
          className={cn(
            "text-sm mt-1",
            tunnelState === "connected" ? "text-status-ok" : "text-status-err",
          )}
        >
          {tunnelState === "connected"
            ? t("settingsX.adv.tunnelConnected")
            : t("settingsX.adv.tunnelDisconnected")}
        </p>
      ) : null}
      {status.running && !pairingUrl ? (
        <div className="mt-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void regenPairing()}>
            {t("settingsX.adv.regenQr")}
          </Button>
          <p className="text-xs text-muted-foreground mt-1">{t("settingsX.adv.regenQrHint")}</p>
        </div>
      ) : null}
      {pairingUrl ? (
        <div className="mt-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{t("settingsX.adv.pairingQrLabel")}</p>
            <Button type="button" variant="ghost" size="sm" onClick={() => void regenPairing()}>
              {t("settingsX.adv.refresh")}
            </Button>
          </div>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t("settingsX.adv.pairingQrAlt")}
              className="mt-2 rounded-md bg-white p-2"
              width={220}
              height={220}
            />
          ) : null}
          <p className="text-xs text-muted-foreground mt-2">{t("settingsX.adv.orOpenManually")}</p>
          <pre className="text-xs whitespace-pre-wrap break-all bg-muted rounded-md p-2 mt-1">
            {pairingUrl}
          </pre>
        </div>
      ) : null}
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium">{t("settingsX.adv.trustedDevices")}</h4>
          {passcodeSet ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void changePasscode()}>
              {t("settingsX.adv.changePasscode")}
            </Button>
          ) : null}
        </div>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settingsX.adv.noTrustedDevices")}</p>
        ) : (
          devices.map((device) => {
            const online = onlineIds.includes(device.id);
            return (
              <div
                key={device.id}
                className="flex items-center justify-between gap-2 text-sm rounded-md px-2 py-1.5 hover:bg-muted/50"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      "inline-block h-2 w-2 rounded-full shrink-0",
                      online ? "bg-status-ok" : "bg-status-idle",
                    )}
                    title={online ? t("settingsX.adv.online") : t("settingsX.adv.offline")}
                  />
                  <span className="truncate">{device.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {online ? t("settingsX.adv.online") : relativeTime(device.lastSeenAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void renameDevice(device)}
                  >
                    {t("settingsX.adv.rename")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void removeDevice(device)}
                  >
                    {t("settingsX.adv.delete")}
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
