import type { ModelOption } from "../chat/ModelPill";
import { ChatGatewayPanel } from "../credentials/ChatGatewayPanel";
import type { MimiPresencePatch, MimiPresenceSnapshot } from "../../shared/mimi-presence";
import { AppearanceSection } from "./settings/AppearanceSection";
import { ConversationSection } from "./settings/ConversationSection";
import { MemorySection } from "./settings/MemorySection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { PetSettingsShell } from "./settings/PetSettingsShell";
import { RulesSection } from "./settings/RulesSection";
import type { MimiSettingsSection } from "./settings/mimiSettingsSections";

export interface PetSettingsPageProps {
  section: MimiSettingsSection;
  onSectionChange: (section: MimiSettingsSection) => void;
  backLabel: string;
  onBack: () => void;
  activeModelKey: string | null;
  modelOptions: ModelOption[];
  hasModelOverride: boolean;
  onSelectModel: (option: ModelOption) => void;
  onResetModel: () => void;
  widgetVisible: boolean;
  /** Actual presence from the main-process owner; null until it is known. */
  presence?: MimiPresenceSnapshot | null;
  presenceError?: string | null;
  onDismissPresenceError?: () => void;
  onWidgetVisibleChange: (visible: boolean) => void;
  onPresenceChange?: (patch: MimiPresencePatch) => void;
  onPreviewMoving?: () => Promise<void>;
  onRetryPresence?: () => void;
  onOpenMemoryCenter: () => void;
}

/**
 * Mimi's own settings page, separate from the global settings center (which
 * links here). One section at a time; the shell owns navigation and "back".
 */
export function PetSettingsPage({
  section,
  onSectionChange,
  backLabel,
  onBack,
  activeModelKey,
  modelOptions,
  hasModelOverride,
  onSelectModel,
  onResetModel,
  widgetVisible,
  presence = null,
  presenceError,
  onDismissPresenceError,
  onWidgetVisibleChange,
  onPresenceChange,
  onPreviewMoving,
  onRetryPresence,
  onOpenMemoryCenter,
}: PetSettingsPageProps) {
  return (
    <PetSettingsShell
      section={section}
      onSectionChange={onSectionChange}
      backLabel={backLabel}
      onBack={onBack}
    >
      {(jumpTo) => (
        <>
          {section === "appearance" && (
            <AppearanceSection
              widgetVisible={widgetVisible}
              presence={presence}
              presenceError={presenceError}
              onDismissPresenceError={onDismissPresenceError}
              onVisibleChange={onWidgetVisibleChange}
              onPresenceChange={onPresenceChange}
              onPreviewMoving={onPreviewMoving}
              onRetryPresence={onRetryPresence}
            />
          )}
          {section === "conversation" && (
            <ConversationSection
              activeModelKey={activeModelKey}
              modelOptions={modelOptions}
              hasModelOverride={hasModelOverride}
              onSelectModel={onSelectModel}
              onResetModel={onResetModel}
            />
          )}
          {section === "notifications" && (
            <NotificationsSection onManageChannels={() => jumpTo("connections")} />
          )}
          {section === "rules" && (
            <RulesSection onOpenNotifications={() => jumpTo("notifications")} />
          )}
          {section === "memory" && <MemorySection onOpenMemoryCenter={onOpenMemoryCenter} />}
          {section === "connections" && <ChatGatewayPanel />}
        </>
      )}
    </PetSettingsShell>
  );
}
