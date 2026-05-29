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
  Globe,
  Monitor,
  Archive,
  Puzzle,
  Bot,
  Brain,
} from "lucide-react";
import { ModelSection } from "./ModelSection";
import { MemorySection } from "./MemorySection";
import { PermissionSection } from "./PermissionSection";
import { McpSection } from "./McpSection";
import { UpdaterSettingsRow } from "../updater/UpdaterBanner";
import { PluginsAndSkillsSection } from "./PluginsAndSkillsSection";
import { AgentsSection } from "./AgentsSection";
import { AppearanceSection } from "./AppearanceSection";
import {
  ArchivedConversationsSection,
  ConnectionsSection,
  EnvironmentSection,
  GitSection,
  HooksSection,
  ImageSettingsSection,
  PersonalizationSection,
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
  | "browser"
  | "computer"
  | "archived"
  | "plugins-skills"
  | "agents"
  | "memory"
  | "update";

interface Module {
  id: ModuleId;
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
}

const MODULES: Module[] = [
  { id: "general", label: "常规", Icon: SettingsIcon },
  { id: "appearance", label: "外观", Icon: Sun },
  { id: "config", label: "配置", Icon: Sliders },
  { id: "personalization", label: "个性化", Icon: User },
  { id: "shortcuts", label: "键盘快捷键", Icon: Keyboard },
  { id: "mcp", label: "MCP 服务器", Icon: Plug },
  { id: "hooks", label: "钩子", Icon: Webhook },
  { id: "connections", label: "连接", Icon: Wifi },
  { id: "git", label: "Git", Icon: GitBranch },
  { id: "environment", label: "环境", Icon: Terminal },
  { id: "browser", label: "浏览器", Icon: Globe },
  { id: "computer", label: "电脑操控", Icon: Monitor },
  { id: "archived", label: "已归档对话", Icon: Archive },
  { id: "plugins-skills", label: "插件与 Skills", Icon: Puzzle },
  { id: "agents", label: "子代理", Icon: Bot },
  { id: "memory", label: "记忆", Icon: Brain },
];

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
  const [scope, setScope] = useState<"user" | "project">("user");

  const supportsProjectScope =
    active === "general" ||
    active === "config" ||
    active === "personalization" ||
    active === "mcp" ||
    active === "hooks" ||
    active === "connections" ||
    active === "environment" ||
    active === "browser" ||
    active === "computer" ||
    active === "memory";

  return (
    <div className="settings-page">
      <div className="settings-page-body">
        <nav className="settings-page-modules">
          <button className="settings-page-back" onClick={onBack}>
            <ArrowLeft size={14} />
            <span>返回应用</span>
          </button>
          {MODULES.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`settings-page-module${active === id ? " active" : ""}`}
              onClick={() => setActive(id)}
            >
              <Icon size={13} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <main className="settings-page-content">
          <div className="settings-page-content-head">
            <h2 className="settings-page-content-title">
              {MODULES.find((m) => m.id === active)?.label}
            </h2>
            {supportsProjectScope && (
              <div className="settings-scope">
                <button
                  className={`logs-bucket${scope === "user" ? " active" : ""}`}
                  title="所有项目的默认配置"
                  onClick={() => setScope("user")}
                >
                  全局
                </button>
                <button
                  className={`logs-bucket${scope === "project" ? " active" : ""}`}
                  disabled={!activeRepoPath}
                  title={activeRepoPath ? "仅当前项目，覆盖全局默认" : "先在左侧选一个项目"}
                  onClick={() => setScope("project")}
                >
                  当前项目
                </button>
              </div>
            )}
          </div>

          <div className="settings-page-module-body">
            {active === "general" && (
              <>
                <PermissionSection scope={scope} activeRepoPath={activeRepoPath} />
                <UpdaterSettingsRow />
              </>
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
              <PersonalizationSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "shortcuts" && (
              <ShortcutsSection />
            )}
            {active === "mcp" && (
              <McpSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "hooks" && (
              <HooksSection scope={scope} activeRepoPath={activeRepoPath} />
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
            {active === "browser" && (
              <ToggleCapabilitySection
                scope={scope}
                activeRepoPath={activeRepoPath}
                settingKey="browser"
                title="浏览器"
                description="控制是否在会话中启用浏览器相关能力。"
              />
            )}
            {active === "computer" && (
              <ToggleCapabilitySection
                scope={scope}
                activeRepoPath={activeRepoPath}
                settingKey="computer"
                title="电脑操控"
                description="控制是否在会话中启用本机应用操控能力。"
              />
            )}
            {active === "plugins-skills" && (
              <PluginsAndSkillsSection activeRepoPath={activeRepoPath} />
            )}
            {active === "agents" && (
              <AgentsSection activeRepoPath={activeRepoPath} />
            )}
            {active === "memory" && (
              <MemorySection scope={scope} activeRepoPath={activeRepoPath} />
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
