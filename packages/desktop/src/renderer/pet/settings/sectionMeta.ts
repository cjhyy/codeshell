import {
  BellRing,
  Brain,
  ListChecks,
  MessageCircleMore,
  MessagesSquare,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "../../i18n";
import type { MimiSettingsSection } from "./mimiSettingsSections";

/** Icon and copy keys of each Mimi settings section (page nav and settings-center entry). */
export const MIMI_SETTINGS_SECTION_META: Record<
  MimiSettingsSection,
  { Icon: LucideIcon; title: TranslationKey; description: TranslationKey }
> = {
  appearance: {
    Icon: Sparkles,
    title: "mimiSettings.section.appearance.title",
    description: "mimiSettings.section.appearance.description",
  },
  conversation: {
    Icon: MessageCircleMore,
    title: "mimiSettings.section.conversation.title",
    description: "mimiSettings.section.conversation.description",
  },
  notifications: {
    Icon: BellRing,
    title: "mimiSettings.section.notifications.title",
    description: "mimiSettings.section.notifications.description",
  },
  rules: {
    Icon: ListChecks,
    title: "mimiSettings.section.rules.title",
    description: "mimiSettings.section.rules.description",
  },
  memory: {
    Icon: Brain,
    title: "mimiSettings.section.memory.title",
    description: "mimiSettings.section.memory.description",
  },
  connections: {
    Icon: MessagesSquare,
    title: "mimiSettings.section.connections.title",
    description: "mimiSettings.section.connections.description",
  },
};
