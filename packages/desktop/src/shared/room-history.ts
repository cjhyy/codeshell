import type {
  RoomHistoryPage,
  RoomHistoryRequest,
  RoomMessage,
} from "@cjhyy/code-shell-server/mobile-remote";

export interface RoomHistoryOperations {
  "rooms/messages": {
    input: { rootIdentity: string; roomId: string; sinceSeq: number };
    result: RoomMessage[];
  };
  "rooms/historyPage": {
    input: { rootIdentity: string; roomId: string; request: RoomHistoryRequest };
    result: RoomHistoryPage<RoomMessage>;
  };
}

export interface RoomHistoryAccess {
  getMessages(roomId: string, sinceSeq?: number): Promise<RoomMessage[]> | RoomMessage[];
  getHistoryPage(
    roomId: string,
    request?: RoomHistoryRequest,
  ): Promise<RoomHistoryPage<RoomMessage>> | RoomHistoryPage<RoomMessage>;
}
