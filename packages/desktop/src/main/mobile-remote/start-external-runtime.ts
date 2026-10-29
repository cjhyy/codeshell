import type { BrowserWindow } from "electron";
import type { AgentBridge } from "../agent-bridge.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";
import type { MobileRuntimeStart } from "./external-runtime-commands.js";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import { assertDesktopSessionId } from "../session-validation.js";
import { getSessionEvents } from "../rawTranscript.js";
import { buildExternalRuntimeHandoffFromEvents } from "../external-runtime-handoff.js";

/** The paired browser never names a window. Main pins a live owner before startup. */
export async function startMobileExternalRuntime(
  deps: {
    service: () => ExternalRuntimeService | null;
    bridge: () => Pick<AgentBridge, "panelOwnerWebContentsId" | "isSessionRunning"> | null;
    windows: () => Iterable<BrowserWindow>;
    history?: typeof getSessionEvents;
  },
  request: MobileRuntimeStart,
): Promise<void> {
  const service = deps.service();
  const bridge = deps.bridge();
  if (!service || !bridge) throw new Error("桌面运行时尚未就绪。");
  assertDesktopSessionId(request.sessionId);
  const parsed = parseExternalRuntimeModelKey(request.modelKey);
  if (!parsed) throw new Error("请选择有效的 Claude Code 或 Codex 模型。");
  const existingOwner = bridge.panelOwnerWebContentsId(request.sessionId);
  if (existingOwner !== request.owner) throw new Error("会话所属桌面窗口已改变，请重新选择会话。");
  const ownerWindow = [...deps.windows()].find(
    (window) =>
      !window.isDestroyed() &&
      (existingOwner === undefined || window.webContents.id === existingOwner),
  );
  if (!ownerWindow) throw new Error("请先打开一个 CodeShell 桌面窗口。");
  const ownerId = ownerWindow.webContents.id;
  const assertCurrent = () => {
    request.assertCurrent();
    const owner = bridge.panelOwnerWebContentsId(request.sessionId);
    if (
      deps.service() !== service ||
      deps.bridge() !== bridge ||
      ownerWindow.isDestroyed() ||
      (owner !== undefined && owner !== ownerId)
    )
      throw new Error("手机连接或桌面会话归属已改变。");
  };
  assertCurrent();
  if (!service.get(request.sessionId) && bridge.isSessionRunning(request.sessionId))
    throw new Error("请先停止当前任务，再切换运行时。");
  const initialContext = buildExternalRuntimeHandoffFromEvents(
    await (deps.history ?? getSessionEvents)(request.sessionId),
  );
  assertCurrent();
  await service.ensureContinuation({
    kind: parsed.kind,
    sessionId: request.sessionId,
    cwd: request.cwd,
    mainRoot: request.mainRoot,
    modelKey: request.modelKey,
    ...(parsed.model ? { model: parsed.model } : {}),
    permissionMode: request.permissionMode,
    initialContext,
    ownerWindow,
    assertStartAuthority: assertCurrent,
  });
  assertCurrent();
}
