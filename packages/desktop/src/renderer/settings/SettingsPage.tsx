import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Search,
  Settings as SettingsIcon,
  Sun,
  Sliders,
  User,
  Keyboard,
  Plug,
  Webhook,
  Wifi,
  GitBranch,
  Terminal,
  ShieldCheck,
  Archive,
  Puzzle,
  Bot,
  Brain,
  Layers,
  LayoutTemplate,
  Smartphone,
  MessageSquare,
  Gauge,
  X,
} from "lucide-react";
import { TextConnectionsPanel } from "./TextConnectionsPanel";
import { ModelCatalogPanel } from "./ModelCatalogPanel";
import { MemorySection } from "./MemorySection";
import { McpSection } from "./McpSection";
import { GeneralSection } from "./GeneralSection";
import { ExtensionsPage } from "../extensions/ExtensionsPage";
import { AgentsSection } from "./AgentsSection";
import { SandboxSection } from "./SandboxSection";
import { AppearanceSection } from "./AppearanceSection";
import { CapabilitiesOverviewSection } from "./CapabilitiesOverviewSection";
import { ConversationSettingsSection } from "./ConversationSettingsSection";
import { ContextSettingsSection } from "./ContextSettingsSection";
import {
  ArchivedConversationsSection,
  ConnectionsSection,
  EnvironmentSection,
  GitSection,
  HooksSection,
  ImageSettingsSection,
  InstructionFilesSection,
  MobileRemoteSection,
  PersonalizationSection,
  ResponsePrefsSection,
  ShortcutsSection,
} from "./AdvancedSections";
import { projectLabel } from "../projects";
import type { TrackedProject } from "../projects";
import type { SessionIndex } from "../transcripts";
import { useT } from "../i18n/I18nProvider";
import type { TFunction } from "../i18n/I18nProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SimpleSelect } from "@/components/ui/simple-select";
import { cn } from "@/lib/utils";

type ModuleId =
  | "general"
  | "appearance"
  | "config"
  | "model-catalog"
  | "personalization"
  | "shortcuts"
  | "mcp"
  | "hooks"
  | "connections"
  | "git"
  | "environment"
  | "sandbox"
  | "conversation"
  | "context"
  | "mobile-remote"
  | "capabilities"
  | "plugins-skills"
  | "agents"
  | "memory"
  | "archived";

type SettingsScopeKind = "user" | "project";
export type SettingsScope = { kind: "user" } | { kind: "project"; path: string };

interface Module {
  id: ModuleId;
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
  /** Which scopes this module can render in. Defaults to user-only. */
  scopes?: SettingsScopeKind[];
}

interface ModuleGroup {
  /** Section header shown above the group; "" renders no header. */
  title: string;
  modules: Module[];
}

export function moduleSupportsScope(
  module: { scopes?: SettingsScopeKind[] },
  scope: SettingsScope,
): boolean {
  return (module.scopes ?? ["user"]).includes(scope.kind);
}

const SETTINGS_LAST_MODULE_KEY = "codeshell:settings:last-module";

function storedModuleId(modules: Module[]): ModuleId {
  if (typeof window === "undefined") return "general";
  try {
    const stored = window.localStorage.getItem(SETTINGS_LAST_MODULE_KEY);
    return modules.some(({ id }) => id === stored) ? (stored as ModuleId) : "general";
  } catch {
    return "general";
  }
}

export function matchesSettingsModule(query: string, label: string, groupTitle: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return `${label} ${groupTitle}`.toLocaleLowerCase().includes(needle);
}

/**
 * Grouped left-nav. The "扩展能力" group is the #4 conceptual
 * unification: MCP servers, plugins/skills, subagents, and hooks are
 * all "ways to extend what the agent can do", so they live under one
 * heading instead of being scattered through a flat list. The data
 * surfaces (each section's own UI) are unchanged — this is the
 * information-architecture half of the alignment.
 */
function buildModuleGroups(t: TFunction): ModuleGroup[] {
  return [
    {
      title: "",
      modules: [
        {
          id: "general",
          label: t("settingsX.page.general"),
          Icon: SettingsIcon,
          scopes: ["user", "project"],
        },
        { id: "appearance", label: t("settingsX.page.appearance"), Icon: Sun },
        {
          id: "config",
          label: t("settingsX.page.config"),
          Icon: Sliders,
          scopes: ["user", "project"],
        },
        // model-catalog deliberately stays user-only: ModelCatalogPanel
        // ignores its scope props (window.codeshell.getModelCatalog has no
        // per-project variant), so offering it in project scope would lie.
        { id: "model-catalog", label: t("settingsX.page.modelCatalog"), Icon: LayoutTemplate },
        {
          id: "personalization",
          label: t("settingsX.page.personalization"),
          Icon: User,
          scopes: ["user", "project"],
        },
        { id: "shortcuts", label: t("settingsX.page.shortcuts"), Icon: Keyboard },
      ],
    },
    {
      title: t("settingsX.page.groupExtend"),
      modules: [
        { id: "capabilities", label: t("settingsX.page.capabilities"), Icon: Layers },
        { id: "mcp", label: t("settingsX.page.mcp"), Icon: Plug, scopes: ["user", "project"] },
        { id: "plugins-skills", label: t("settingsX.page.plugins"), Icon: Puzzle },
        { id: "agents", label: t("settingsX.page.agents"), Icon: Bot },
        { id: "hooks", label: t("settingsX.page.hooks"), Icon: Webhook },
      ],
    },
    {
      title: t("settingsX.page.groupEnvConn"),
      modules: [
        {
          id: "connections",
          label: t("settingsX.page.connections"),
          Icon: Wifi,
          scopes: ["user", "project"],
        },
        { id: "git", label: "Git", Icon: GitBranch },
        { id: "environment", label: t("settingsX.page.environment"), Icon: Terminal },
        { id: "sandbox", label: t("settingsX.page.sandbox"), Icon: ShieldCheck },
        { id: "conversation", label: t("settingsX.page.conversation"), Icon: MessageSquare },
        { id: "context", label: t("settingsX.page.context"), Icon: Gauge },
        { id: "mobile-remote", label: t("settingsX.page.mobileRemote"), Icon: Smartphone },
      ],
    },
    {
      title: t("settingsX.page.groupData"),
      modules: [
        { id: "memory", label: t("settingsX.page.memory"), Icon: Brain },
        { id: "archived", label: t("settingsX.page.archived"), Icon: Archive },
      ],
    },
  ];
}

interface Props {
  activeProjectPath: string | null;
  /** When set, open in project scope for this project (project_config route). */
  initialProjectPath?: string | null;
  projects: TrackedProject[];
  sessionIndices: Record<string, SessionIndex>;
  onRestoreArchivedSession: (projectId: string | null, sessionId: string) => void;
  onDeleteArchivedSession: (projectId: string | null, sessionId: string) => void;
  isMac: boolean;
  isFullscreen: boolean;
  onBack: () => void;
}

/**
 * Full-page Settings (matches the settings-page reference screenshot).
 *
 * Layout: top header with ← 返回应用, left module list, right content
 * panel. Each module renders into the right panel; existing section
 * components (ModelSection / PermissionSection / McpSection / etc.)
 * are reused so we don't fork the model/permission/mcp UIs.
 */
export function SettingsPage({
  activeProjectPath,
  initialProjectPath,
  projects,
  sessionIndices,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  isMac,
  isFullscreen,
  onBack,
}: Props) {
  const { t } = useT();
  const MODULE_GROUPS = useMemo(() => buildModuleGroups(t), [t]);
  const MODULES = useMemo(() => MODULE_GROUPS.flatMap((group) => group.modules), [MODULE_GROUPS]);
  const [active, setActive] = useState<ModuleId>(() => storedModuleId(MODULES));
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [scopeState, setScopeState] = useState<SettingsScope>(() =>
    initialProjectPath ? { kind: "project", path: initialProjectPath } : { kind: "user" },
  );
  // The selected project disappeared (removed from tracked list) → fall back to global.
  useEffect(() => {
    if (scopeState.kind === "project" && !projects.some((p) => p.path === scopeState.path)) {
      setScopeState({ kind: "user" });
    }
  }, [projects, scopeState]);
  const scope: "user" | "project" = scopeState.kind;
  const scopeProjectPath = scopeState.kind === "project" ? scopeState.path : null;
  const showTrafficLightGutter = isMac && !isFullscreen;
  const activeModule = MODULES.find((module) => module.id === active) ?? MODULES[0];
  const activeGroup =
    MODULE_GROUPS.find((group) => group.modules.some((module) => module.id === active))?.title ??
    "";
  const filteredGroups = useMemo(
    () =>
      MODULE_GROUPS.map((group) => ({
        ...group,
        modules: group.modules.filter(
          (module) =>
            moduleSupportsScope(module, scopeState) &&
            matchesSettingsModule(query, module.label, group.title),
        ),
      })).filter((group) => group.modules.length > 0),
    [MODULE_GROUPS, query, scopeState],
  );
  const resultCount = filteredGroups.reduce((count, group) => count + group.modules.length, 0);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_LAST_MODULE_KEY, active);
    } catch {
      // Storage can be disabled; settings navigation still works in-memory.
    }
  }, [active]);

  // Scope switch can leave a module active that the new scope doesn't
  // support → jump to the first module available in that scope.
  useEffect(() => {
    if (activeModule && !moduleSupportsScope(activeModule, scopeState)) {
      const first = MODULES.find((module) => moduleSupportsScope(module, scopeState));
      if (first) setActive(first.id);
    }
  }, [scopeState, activeModule, MODULES]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const selectModule = (id: ModuleId) => {
    setActive(id);
    setQuery("");
  };

  const mobileOptions = MODULE_GROUPS.map((group) => ({
    label: group.title || t("settingsX.page.settings"),
    options: group.modules
      .filter((module) => moduleSupportsScope(module, scopeState))
      .map((module) => ({ value: module.id, label: module.label })),
  })).filter((group) => group.options.length > 0);

  const scopeOptions = [
    { value: "__user__", label: t("settingsX.page.scopeSwitchGlobal") },
    ...projects.map((project) => ({ value: project.path, label: projectLabel(project) })),
  ];

  return (
    <div className="h-full bg-background">
      <div className="flex h-full max-[720px]:flex-col">
        <nav
          aria-label={t("settingsX.page.settingsNav")}
          className={cn(
            "w-64 shrink-0 overflow-y-auto border-r border-border bg-muted/20 px-3 pb-4 max-[720px]:hidden",
            showTrafficLightGutter ? "pt-8" : "pt-4",
          )}
        >
          <Button
            variant="ghost"
            size="sm"
            className="mb-4 w-full justify-start gap-1.5 px-2 text-muted-foreground"
            onClick={onBack}
          >
            <ArrowLeft size={14} />
            <span>{t("settingsX.page.back")}</span>
          </Button>

          <div className="relative mb-3">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchRef}
              value={query}
              type="search"
              className="h-8 pl-8 pr-8 text-xs"
              placeholder={t("settingsX.page.searchPlaceholder")}
              aria-label={t("settingsX.page.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0.5 top-0.5 size-7 text-muted-foreground"
                aria-label={t("settingsX.page.clearSearch")}
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>

          {query ? (
            <p className="mb-2 px-2 text-[11px] text-muted-foreground">
              {t("settingsX.page.searchResults", { count: resultCount })}
            </p>
          ) : null}

          {filteredGroups.map((group) => (
            <div key={group.title || "_top"} className="mb-3">
              {group.title && (
                <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </div>
              )}
              {group.modules.map(({ id, label, Icon }) => (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "mb-0.5 h-8 w-full justify-start gap-2 px-2 text-sm font-normal",
                    active === id
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                  aria-current={active === id ? "page" : undefined}
                  onClick={() => selectModule(id)}
                >
                  <Icon size={13} />
                  <span className="truncate">{label}</span>
                </Button>
              ))}
            </div>
          ))}

          {filteredGroups.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-3 text-center">
              <p className="text-xs text-muted-foreground">{t("settingsX.page.noSearchResults")}</p>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="mt-1 h-auto px-0"
                onClick={() => setQuery("")}
              >
                {t("settingsX.page.clearSearch")}
              </Button>
            </div>
          ) : null}
        </nav>

        <div className="hidden shrink-0 border-b border-border bg-card px-3 py-2 max-[720px]:flex max-[720px]:items-center max-[720px]:gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={t("settingsX.page.back")}
            onClick={onBack}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <SimpleSelect<ModuleId>
            value={active}
            options={mobileOptions}
            ariaLabel={t("settingsX.page.settingsNav")}
            className="min-w-0 flex-1"
            onChange={selectModule}
          />
        </div>

        <main className="min-w-0 flex-1 overflow-y-auto px-8 pb-10 pt-8 max-[720px]:px-4 max-[720px]:pt-5">
          <div className="mx-auto w-full max-w-5xl">
            <div className="mb-6 border-b border-border pb-4">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                {activeGroup ? (
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {activeGroup}
                  </span>
                ) : null}
                <SimpleSelect<string>
                  value={scopeState.kind === "user" ? "__user__" : scopeState.path}
                  options={scopeOptions}
                  size="sm"
                  ariaLabel={t("settingsX.page.scopeSwitcher")}
                  onChange={(value) =>
                    setScopeState(
                      value === "__user__" ? { kind: "user" } : { kind: "project", path: value },
                    )
                  }
                />
              </div>
              <h1 className="text-xl font-semibold tracking-tight">{activeModule?.label}</h1>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                {scopeState.kind === "project"
                  ? t("settingsX.page.projectScopeHint")
                  : t("settingsX.page.globalScopeHint")}
              </p>
            </div>

            <div className="flex flex-col gap-6">
              {active === "general" && (
                <GeneralSection
                  scope={scope}
                  activeProjectPath={scopeProjectPath ?? activeProjectPath}
                />
              )}
              {active === "appearance" && <AppearanceSection />}
              {active === "config" && (
                <>
                  <TextConnectionsPanel
                    scope={scope}
                    activeProjectPath={scopeProjectPath ?? activeProjectPath}
                  />
                  <ImageSettingsSection
                    scope={scope}
                    activeProjectPath={scopeProjectPath ?? activeProjectPath}
                  />
                </>
              )}
              {active === "model-catalog" && (
                <ModelCatalogPanel
                  scope={scope}
                  activeProjectPath={scopeProjectPath ?? activeProjectPath}
                />
              )}
              {active === "personalization" && (
                <>
                  <InstructionFilesSection
                    scope={scope}
                    activeProjectPath={scopeProjectPath ?? activeProjectPath}
                  />
                  <ResponsePrefsSection
                    scope={scope}
                    activeProjectPath={scopeProjectPath ?? activeProjectPath}
                  />
                  <PersonalizationSection
                    scope={scope}
                    activeProjectPath={scopeProjectPath ?? activeProjectPath}
                  />
                </>
              )}
              {active === "shortcuts" && <ShortcutsSection />}
              {active === "capabilities" && (
                <CapabilitiesOverviewSection
                  projects={projects}
                  onNavigateToKind={(kind) => {
                    const target: Record<string, ModuleId> = {
                      mcp: "mcp",
                      skill: "plugins-skills",
                      plugin: "plugins-skills",
                      agent: "agents",
                    };
                    const next = target[kind];
                    if (next) selectModule(next);
                  }}
                />
              )}
              {active === "mcp" && (
                <McpSection
                  scope={scope}
                  activeProjectPath={scopeProjectPath ?? activeProjectPath}
                />
              )}
              {active === "hooks" && <HooksSection projects={projects} />}
              {active === "connections" && (
                <ConnectionsSection
                  scope={scope}
                  activeProjectPath={scopeProjectPath ?? activeProjectPath}
                />
              )}
              {active === "git" && <GitSection />}
              {active === "environment" && <EnvironmentSection projects={projects} />}
              {active === "sandbox" && <SandboxSection projects={projects} />}
              {active === "conversation" && <ConversationSettingsSection />}
              {active === "context" && <ContextSettingsSection />}
              {active === "mobile-remote" && <MobileRemoteSection />}
              {active === "plugins-skills" && (
                <ExtensionsPage activeProjectPath={activeProjectPath} showDiscover={false} />
              )}
              {active === "agents" && <AgentsSection projects={projects} />}
              {active === "memory" && (
                <MemorySection
                  scope={scope}
                  activeProjectPath={scopeProjectPath ?? activeProjectPath}
                  projects={projects}
                />
              )}
              {active === "archived" && (
                <ArchivedConversationsSection
                  projects={projects}
                  sessionIndices={sessionIndices}
                  onRestore={onRestoreArchivedSession}
                  onDelete={onDeleteArchivedSession}
                />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
