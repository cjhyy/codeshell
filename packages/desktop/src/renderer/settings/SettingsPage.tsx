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
  Workflow,
  Globe,
  Monitor,
  Archive,
  Puzzle,
} from "lucide-react";
import { ModelSection } from "./ModelSection";
import { PermissionSection } from "./PermissionSection";
import { McpSection } from "./McpSection";
import { UpdaterSettingsRow } from "../updater/UpdaterBanner";
import { PluginsAndSkillsSection } from "./PluginsAndSkillsSection";
import { AppearanceSection } from "./AppearanceSection";

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
  | "worktree"
  | "browser"
  | "computer"
  | "archived"
  | "plugins-skills"
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
  { id: "worktree", label: "工作树", Icon: Workflow },
  { id: "browser", label: "浏览器", Icon: Globe },
  { id: "computer", label: "电脑操控", Icon: Monitor },
  { id: "archived", label: "已归档对话", Icon: Archive },
  { id: "plugins-skills", label: "插件与 Skills", Icon: Puzzle },
];

interface Props {
  activeRepoPath: string | null;
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
export function SettingsPage({ activeRepoPath, onBack }: Props) {
  const [active, setActive] = useState<ModuleId>("general");
  const [scope, setScope] = useState<"user" | "project">("user");

  const supportsProjectScope =
    active === "general" ||
    active === "config" ||
    active === "mcp" ||
    active === "hooks";

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <button className="settings-page-back" onClick={onBack}>
          <ArrowLeft size={14} />
          <span>返回应用</span>
        </button>
      </header>

      <div className="settings-page-body">
        <nav className="settings-page-modules">
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
                  onClick={() => setScope("user")}
                >
                  user
                </button>
                <button
                  className={`logs-bucket${scope === "project" ? " active" : ""}`}
                  disabled={!activeRepoPath}
                  title={activeRepoPath ?? "先在左侧选一个项目"}
                  onClick={() => setScope("project")}
                >
                  project
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
              <ModelSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "mcp" && (
              <McpSection scope={scope} activeRepoPath={activeRepoPath} />
            )}
            {active === "plugins-skills" && (
              <PluginsAndSkillsSection activeRepoPath={activeRepoPath} />
            )}

            {/* Modules that don't have a real implementation yet show a
                placeholder rather than disappearing. Better visible
                'todo' than silent breakage. */}
            {(active === "personalization" ||
              active === "shortcuts" ||
              active === "hooks" ||
              active === "connections" ||
              active === "git" ||
              active === "environment" ||
              active === "worktree" ||
              active === "browser" ||
              active === "computer" ||
              active === "archived") && (
              <section className="settings-section">
                <div className="approvals-empty">
                  「{MODULES.find((m) => m.id === active)?.label}」模块的设置项还未实现。
                </div>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
