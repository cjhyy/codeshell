import React, { useState } from "react";
import {
  ArrowLeft,
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
  Smartphone,
  MessageSquare,
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
  ToggleCapabilitySection,
} from "./AdvancedSections";
import type { Repo } from "../repos";
import type { SessionIndex } from "../transcripts";
import { useT } from "../i18n/I18nProvider";
import type { TFunction } from "../i18n/I18nProvider";

type ModuleId =
  | "general"
  | "appearance"
  | "config"
  | "personalization"
  | "shortcuts"
  | "mcp"
  | "hooks"
  | "connections"
  | "git"
  | "environment"
  | "sandbox"
  | "conversation"
  | "mobile-remote"
  | "archived"
  | "capabilities"
  | "plugins-skills"
  | "agents"
  | "memory"
  | "update";

interface Module {
  id: ModuleId;
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
}

interface ModuleGroup {
  /** Section header shown above the group; "" renders no header. */
  title: string;
  modules: Module[];
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
        { id: "general", label: t("settingsX.page.general"), Icon: SettingsIcon },
        { id: "appearance", label: t("settingsX.page.appearance"), Icon: Sun },
        { id: "config", label: t("settingsX.page.config"), Icon: Sliders },
        { id: "personalization", label: t("settingsX.page.personalization"), Icon: User },
        { id: "shortcuts", label: t("settingsX.page.shortcuts"), Icon: Keyboard },
      ],
    },
    {
      title: t("settingsX.page.groupExtend"),
      modules: [
        { id: "capabilities", label: t("settingsX.page.capabilities"), Icon: Layers },
        { id: "mcp", label: t("settingsX.page.mcp"), Icon: Plug },
        { id: "plugins-skills", label: t("settingsX.page.plugins"), Icon: Puzzle },
        { id: "agents", label: t("settingsX.page.agents"), Icon: Bot },
        { id: "hooks", label: t("settingsX.page.hooks"), Icon: Webhook },
      ],
    },
    {
      title: t("settingsX.page.groupEnvConn"),
      modules: [
        { id: "connections", label: t("settingsX.page.connections"), Icon: Wifi },
        { id: "git", label: "Git", Icon: GitBranch },
        { id: "environment", label: t("settingsX.page.environment"), Icon: Terminal },
        { id: "sandbox", label: t("settingsX.page.sandbox"), Icon: ShieldCheck },
        { id: "conversation", label: t("settingsX.page.conversation"), Icon: MessageSquare },
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
  activeRepoPath: string | null;
  repos: Repo[];
  sessionIndices: Record<string, SessionIndex>;
  onRestoreArchivedSession: (repoId: string | null, sessionId: string) => void;
  onDeleteArchivedSession: (repoId: string | null, sessionId: string) => void;
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
  activeRepoPath,
  repos,
  sessionIndices,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onBack,
}: Props) {
  const { t } = useT();
  const MODULE_GROUPS = buildModuleGroups(t);
  const MODULES: Module[] = MODULE_GROUPS.flatMap((g) => g.modules);
  const [active, setActive] = useState<ModuleId>("general");
  // All settings are global (user scope). Per-project overrides are not
  // supported in the UI; sections still take a `scope`/`activeRepoPath`
  // prop pair, so we pass the fixed user scope through unchanged.
  const scope = "user" as const;

  return (
    <div className="h-full">
      <div className="flex h-full max-[720px]:flex-col">
        <nav className="w-60 shrink-0 overflow-y-auto border-r border-border px-4 pb-4 pt-8 max-[720px]:h-44 max-[720px]:w-full max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:px-3 max-[720px]:py-3">
          <button
            className="mb-5 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeft size={14} />
            <span>{t("settingsX.page.back")}</span>
          </button>
          {MODULE_GROUPS.map((group) => (
            <div key={group.title || "_top"} className="mb-3">
              {group.title && (
                <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </div>
              )}
              {group.modules.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  className={
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors " +
                    (active === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")
                  }
                  onClick={() => setActive(id)}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto px-8 pb-6 pt-8 max-[720px]:px-4 max-[720px]:pt-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight">
              {MODULES.find((m) => m.id === active)?.label}
            </h2>
          </div>

          <div className="flex flex-col gap-6">
            {active === "general" && (
              <GeneralSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "appearance" && (
              <AppearanceSection />
            )}
            {active === "config" && (
              <>
                <TextConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} />
                <ModelCatalogPanel scope={scope} activeRepoPath={activeRepoPath} />
                <ImageSettingsSection scope={scope} activeRepoPath={activeRepoPath} />
              </>
            )}
            {active === "personalization" && (
              <>
                <InstructionFilesSection scope={scope} activeRepoPath={activeRepoPath} />
                <ResponsePrefsSection scope={scope} activeRepoPath={activeRepoPath} />
                <PersonalizationSection scope={scope} activeRepoPath={activeRepoPath} />
              </>
            )}
            {active === "shortcuts" && (
              <ShortcutsSection />
            )}
            {active === "capabilities" && (
              <CapabilitiesOverviewSection
                repos={repos}
                onNavigateToKind={(kind) => {
                  // Jump from a capability row to its dedicated detail tab.
                  // builtin has no detail tab → stay on 能力总览 (no-op).
                  const target: Record<string, ModuleId> = {
                    mcp: "mcp",
                    skill: "plugins-skills",
                    plugin: "plugins-skills",
                    agent: "agents",
                  };
                  const next = target[kind];
                  if (next) setActive(next);
                }}
              />
            )}
            {active === "mcp" && (
              <McpSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "hooks" && (
              // Hooks live at two levels (global user + per project; core
              // concatenates both) — the section shows a "全局" row plus the
              // project list, then drills into the chosen level's hooks.
              <HooksSection repos={repos} />
            )}
            {active === "connections" && (
              <ConnectionsSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "git" && (
              <GitSection />
            )}
            {active === "environment" && (
              // Local environment is project-scoped (setup/cleanup/env).
              <EnvironmentSection repos={repos} />
            )}
            {active === "sandbox" && (
              // Sandbox (isolation + network) is its own tab — global default
              // plus per-project overrides via the drill-in picker.
              <SandboxSection repos={repos} />
            )}
            {active === "conversation" && <ConversationSettingsSection />}
            {active === "mobile-remote" && <MobileRemoteSection />}
            {active === "plugins-skills" && (
              <ExtensionsPage activeRepoPath={activeRepoPath} showDiscover={false} />
            )}
            {active === "agents" && (
              // Sub-agents are project-scoped like 钩子/记忆: pick 全局 or a
              // project first, then edit. Project mode flips a tri-state
              // capabilityOverrides.agents overlay.
              <AgentsSection repos={repos} />
            )}
            {active === "memory" && (
              // Memory: pick a store first (global, or a project), then view
              // that store's entries. Reuses the sidebar `repos` list.
              <MemorySection scope={scope} activeRepoPath={activeRepoPath} repos={repos} />
            )}
            {active === "archived" && (
              <ArchivedConversationsSection
                repos={repos}
                sessionIndices={sessionIndices}
                onRestore={onRestoreArchivedSession}
                onDelete={onDeleteArchivedSession}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
