import type { PanelAppPermission } from "../../shared/panel-apps";
import type { TranslationKey } from "../i18n/dict";
import type { TFunction } from "../i18n/I18nProvider";

const permissionCopyKeys = {
  "context.session": {
    label: "ext.panels.permissionNames.contextSession",
    description: "ext.panels.permissionDescriptions.contextSession",
  },
  "context.workspace": {
    label: "ext.panels.permissionNames.contextWorkspace",
    description: "ext.panels.permissionDescriptions.contextWorkspace",
  },
  storage: {
    label: "ext.panels.permissionNames.storage",
    description: "ext.panels.permissionDescriptions.storage",
  },
  "external.open": {
    label: "ext.panels.permissionNames.externalOpen",
    description: "ext.panels.permissionDescriptions.externalOpen",
  },
  "agent.submitPrompt": {
    label: "ext.panels.permissionNames.agentSubmitPrompt",
    description: "ext.panels.permissionDescriptions.agentSubmitPrompt",
  },
  "agent.task": {
    label: "ext.panels.permissionNames.agentTask",
    description: "ext.panels.permissionDescriptions.agentTask",
  },
  "workspace.info": {
    label: "ext.panels.permissionNames.workspaceInfo",
    description: "ext.panels.permissionDescriptions.workspaceInfo",
  },
  "workspace.read": {
    label: "ext.panels.permissionNames.workspaceRead",
    description: "ext.panels.permissionDescriptions.workspaceRead",
  },
  "workspace.write": {
    label: "ext.panels.permissionNames.workspaceWrite",
    description: "ext.panels.permissionDescriptions.workspaceWrite",
  },
  "notifications.send": {
    label: "ext.panels.permissionNames.notificationsSend",
    description: "ext.panels.permissionDescriptions.notificationsSend",
  },
  "audio.transcribe": {
    label: "ext.panels.permissionNames.audioTranscribe",
    description: "ext.panels.permissionDescriptions.audioTranscribe",
  },
  "credentials.cookies": {
    label: "ext.panels.permissionNames.credentialsCookies",
    description: "ext.panels.permissionDescriptions.credentialsCookies",
  },
  "automations.manage": {
    label: "ext.panels.permissionNames.automationsManage",
    description: "ext.panels.permissionDescriptions.automationsManage",
  },
  process: {
    label: "ext.panels.permissionNames.process",
    description: "ext.panels.permissionDescriptions.process",
  },
  resources: {
    label: "ext.panels.permissionNames.resources",
    description: "ext.panels.permissionDescriptions.resources",
  },
  "resources.directRead": {
    label: "ext.panels.permissionNames.resourcesDirectRead",
    description: "ext.panels.permissionDescriptions.resourcesDirectRead",
  },
  "credentials.connections": {
    label: "ext.panels.permissionNames.credentialsConnections",
    description: "ext.panels.permissionDescriptions.credentialsConnections",
  },
  media: {
    label: "ext.panels.permissionNames.media",
    description: "ext.panels.permissionDescriptions.media",
  },
  "media.capture": {
    label: "ext.panels.permissionNames.mediaCapture",
    description: "ext.panels.permissionDescriptions.mediaCapture",
  },
} as const satisfies Record<
  PanelAppPermission,
  { label: TranslationKey; description: TranslationKey }
>;

export function getPanelAppPermissionCopy(
  permission: string,
  t: TFunction,
): { label: string; description: string; known: boolean } {
  // Retain unfamiliar declarations instead of silently dropping future permissions.
  if (!Object.hasOwn(permissionCopyKeys, permission)) {
    return {
      label: permission,
      description: t("ext.panels.permissionUnknownDescription"),
      known: false,
    };
  }
  const keys = permissionCopyKeys[permission as PanelAppPermission];
  return { label: t(keys.label), description: t(keys.description), known: true };
}
