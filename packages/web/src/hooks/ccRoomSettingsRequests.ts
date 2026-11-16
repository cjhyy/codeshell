import type {
  MobileClientEvent,
  MobileRemotePermissionMode as PermissionMode,
  RoomPublic,
} from "@cjhyy/code-shell-core";
import { t } from "../i18n/translate.js";

/** One correlated open/change request, retained until the Host settles it. */
export interface CcRoomOpenRequest {
  requestId: string;
  roomId?: string;
  modelKey?: string | null;
  sessionId: string;
  cwd: string;
  mode: PermissionMode;
  revision: number;
  switching: boolean;
}

export type CcRoomSettingSelection =
  | { mode: PermissionMode; modelKey?: never }
  | { modelKey: string | null; mode?: never };

type OpenEvent = Extract<MobileClientEvent, { type: "ccRoom.openSession" }>;
type Preparation =
  | { request: CcRoomOpenRequest; event: OpenEvent; notice?: never }
  | { request?: never; event?: never; notice?: string };

/**
 * Capture a settings request from the viewed room without optimistic changes.
 * This is only the local admission check; Host catalog validation, real mode,
 * busy state and authorization remain authoritative across asynchronous waits.
 */
export function prepareCcRoomSettingChange(
  selection: CcRoomSettingSelection,
  current: {
    roomId?: string;
    room?: RoomPublic;
    sessionId?: string;
    cwd?: string;
    kind: RoomPublic["kind"];
    revision: number;
    online: boolean;
    modelSelection: boolean;
    inputPending: boolean;
    changePending: boolean;
    hasQueuedTurns: boolean;
    models: readonly { key: string; kind: RoomPublic["kind"] }[];
  },
): Preparation {
  const { roomId, room, sessionId, cwd } = current;
  const changingModel = selection.modelKey !== undefined;
  if (!roomId || !sessionId || !cwd || (changingModel && room?.id !== roomId)) return {};
  if (current.inputPending)
    return {
      notice: "此会话的消息正在发送或等待确认，请确认发送结果后再切换模型或权限。草稿已保留。",
    };
  if (!current.online) return { notice: t("mobile.connection.offlineTitle") };
  if (changingModel) {
    if (!current.modelSelection) return { notice: "此电脑尚不支持切换 CLI 模型，请更新桌面端。" };
    if (room!.observing) return { notice: t("mobile.notice.ccRoomObserving") };
    if (current.changePending || current.hasQueuedTurns)
      return { notice: "请先等待设置完成或处理此会话的排队消息，再切换模型。" };
    if (
      selection.modelKey !== null &&
      !current.models.some((model) => model.key === selection.modelKey && model.kind === room!.kind)
    )
      return { notice: "该模型不在此 CLI 的可用列表中，请刷新模型列表。" };
    if ((room!.modelKey ?? null) === selection.modelKey) return {};
  }
  // Model-only requests carry the last displayed mode for wire compatibility;
  // the Host preserves the room's actual mode rather than applying this snapshot.
  const mode = changingModel ? room!.permissionMode : selection.mode!;
  const requestId = `cc-${changingModel ? "model" : "mode"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const fields = {
    requestId,
    roomId,
    sessionId,
    cwd,
    mode,
    ...(changingModel ? { modelKey: selection.modelKey } : {}),
  };
  return {
    request: { ...fields, revision: current.revision, switching: true },
    event: {
      type: "ccRoom.openSession",
      ...fields,
      kind: changingModel ? room!.kind : current.kind,
    },
  };
}
