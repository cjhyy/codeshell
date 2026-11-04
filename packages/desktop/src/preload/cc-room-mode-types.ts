import type { CcRoomOpenResult } from "../shared/mobile-remote.js";
import type { RoomPublic } from "./types";

/** ccRoom methods that report the permission mode Main actually runs a CLI room in. */
export interface CcRoomModeApi {
  openSession(
    claudeSessionId: string,
    cwd: string,
    mode: string,
    kind?: "claude-code" | "codex",
  ): Promise<CcRoomOpenResult>;
  /** Another view (a paired phone, another window) restarted a room under a different mode. */
  onRoomState?(cb: (room: RoomPublic) => void): () => void;
}
