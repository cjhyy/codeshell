import type { AuthenticatedMobileClientEvent } from "./handle-client-event.js";
export function isRoomPhoneEvent(event: AuthenticatedMobileClientEvent) {
  return (
    event.type.startsWith("ccRoom.") ||
    event.type.startsWith("room.") ||
    (event.type.startsWith("queue.") && "target" in event && event.target?.kind === "room")
  );
}
