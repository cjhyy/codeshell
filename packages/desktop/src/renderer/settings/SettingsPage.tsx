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
  Archive,
  Puzzle,
  Bot,
  Brain,
  Layers,
} from "lucide-react";
import { ModelSection } from "./ModelSection";
import { MemorySection } from "./MemorySection";
import { McpSection } from "./McpSection";
import { GeneralSection } from "./GeneralSection";
import { ExtensionsPage } from "../extensions/ExtensionsPage";
import { AgentsSection } from "./AgentsSection";
import { AppearanceSection } from "./AppearanceSection";
import { CapabilitiesOverviewSection } from "./CapabilitiesOverviewSection";
import {
  ArchivedConversationsSection,
  ConnectionsSection,
  EnvironmentSection,
  GitSection,
  HooksSection,
  ImageSettingsSection,
  InstructionFilesSection,
  PersonalizationSection,
  ResponsePrefsSection,
  ShortcutsSection,
  ToggleCapabilitySection,
} from "./AdvancedSections";
import type { Repo } from "../repos";
import type { SessionIndex } from "../transcripts";

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
const MODULE_GROUPS: ModuleGroup[] = [
  {
    title: "",
    modules: [
      { id: "general", label: "常规", Icon: SettingsIcon },
      { id: "appearance", label: "外观", Icon: Sun },
      { id: "config", label: "配置", Icon: Sliders },
      { id: "personalization", label: "个性化", Icon: User },
      { id: "shortcuts", label: "键盘快捷键", Icon: Keyboard },
    ],
  },
  {
    title: "扩展能力",
    modules: [
      { id: "capabilities", label: "能力总览", Icon: Layers },
      { id: "mcp", label: "MCP 服务器", Icon: Plug },
      { id: "plugins-skills", label: "扩展", Icon: Puzzle },
      { id: "agents", label: "子代理", Icon: Bot },
      { id: "hooks", label: "钩子", Icon: Webhook },
    ],
  },
  {
    title: "环境与连接",
    modules: [
      { id: "connections", label: "连接", Icon: Wifi },
      { id: "git", label: "Git", Icon: GitBranch },
      { id: "environment", label: "本地环境", Icon: Terminal },
    ],
  },
  {
    title: "数据",
    modules: [
      { id: "memory", label: "记忆", Icon: Brain },
      { id: "archived", label: "已归档对话", Icon: Archive },
    ],
  },
];

const MODULES: Module[] = MODULE_GROUPS.flatMap((g) => g.modules);

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
            <span>返回应用</span>
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
                <ModelSection scope={scope} activeRepoPath={activeRepoPath} />
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
              // Hooks are project-scoped only — the section shows a project
              // list first, then drills into the chosen project's hooks.
              <HooksSection repos={repos} />
            )}
            {active === "connections" && (
              <ConnectionsSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "git" && (
              <GitSection />
            )}
            {active === "environment" && (
              <EnvironmentSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "plugins-skills" && (
              <ExtensionsPage activeRepoPath={activeRepoPath} showDiscover={false} />
            )}
            {active === "agents" && (
              <AgentsSection activeRepoPath={activeRepoPath} />
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
