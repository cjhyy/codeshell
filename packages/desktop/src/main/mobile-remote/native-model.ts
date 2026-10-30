import { SessionManager } from "@cjhyy/code-shell-core";
import {
  configuredTextModelSnapshot,
  readConfiguredTextModelSource,
} from "@cjhyy/code-shell-core/internal";
import type { MobileExternalRuntimeCommands } from "./external-runtime-commands.js";

type NativeAuthority = Awaited<ReturnType<MobileExternalRuntimeCommands["authorizeNative"]>>;

function readConfiguration(sessionId: string, cwd: string) {
  return readConfiguredTextModelSource(
    cwd,
    new SessionManager().readSessionState(sessionId)?.workspaceProfile,
  );
}

/** Resolves only a configured text connection; no endpoint or credential crosses the socket. */
export function prepareMobileNativeModel(
  sessionId: string,
  connectionId: string,
  authority: NativeAuthority,
  read: typeof readConfiguration = readConfiguration,
) {
  const snapshot = () => {
    authority.assertCurrent();
    return configuredTextModelSnapshot(connectionId, read(sessionId, authority.cwd));
  };
  const captured = snapshot();
  return {
    ...authority,
    configuredModel: { id: connectionId, expectedFingerprint: captured.fingerprint },
    nativeConnectionId: connectionId,
    workspaceProfile: captured.workspaceProfile,
    assertCurrent: () => {
      if (snapshot().fingerprint !== captured.fingerprint)
        throw new Error("会话或模型配置已更新，请核对选择后重新发送。");
    },
  };
}
