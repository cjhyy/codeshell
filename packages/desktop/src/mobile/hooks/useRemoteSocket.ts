import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileClientEvent, MobileServerEvent } from "@protocol";
import { deviceStore } from "@mobile/lib/storage";
import { generateSecret } from "@mobile/lib/deviceCredential";
import { parsePairingToken } from "@mobile/lib/pairing";

export type ConnStatus =
  | "connecting" // socket opening
  | "authenticating" // socket open, handshake sent
  | "unpaired" // no deviceId and no pairing token → must scan QR
  | "online" // authenticated
  | "offline"; // socket closed, will retry

/** A parsed server event (typed) OR a raw worker→renderer JSON-RPC line that the
 *  caller folds through streamReducer. We surface both: typed events drive UI
 *  state; raw lines drive the chat reducer. */
export interface RemoteSocket {
  status: ConnStatus;
  deviceName: string;
  /** Send a typed client event (no-op until the socket is open). */
  send: (event: MobileClientEvent) => void;
  /** Manually drop credentials and return to the pairing screen. */
  logout: () => void;
}

export interface RemoteSocketHandlers {
  /** A typed server event (auth/session/approval/room/…). */
  onServerEvent?: (event: MobileServerEvent) => void;
  /** Any raw line (used to fold agent/streamEvent through streamReducer). */
  onRawLine?: (raw: unknown) => void;
}

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 8000;

export function useRemoteSocket(handlers: RemoteSocketHandlers): RemoteSocket {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [deviceName, setDeviceName] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedByUs = useRef(false);
  // Keep latest handlers without retriggering the connect effect.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const send = useCallback((event: MobileClientEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }, []);

  const logout = useCallback(() => {
    deviceStore.clearId();
    closedByUs.current = true;
    wsRef.current?.close();
    // Drop the pairing token from the URL and reload into the unpaired state.
    window.history.replaceState(null, "", window.location.pathname);
    setStatus("unpaired");
  }, []);

  useEffect(() => {
    closedByUs.current = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      const wsUrl = window.location.origin.replace(/^http/, "ws") + "/ws";
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        retryRef.current = 0;
        const pairingToken = parsePairingToken(window.location.search);
        const secret = deviceStore.getOrCreateSecret(() => generateSecret());
        const name = deviceStore.getOrCreateName();
        setDeviceName(name);
        if (pairingToken) {
          setStatus("authenticating");
          ws.send(JSON.stringify({ type: "pair.complete", token: pairingToken, name, secretHash: secret }));
        } else if (deviceStore.getId()) {
          setStatus("authenticating");
          ws.send(JSON.stringify({ type: "auth.device", deviceId: deviceStore.getId(), secretHash: secret }));
        } else {
          setStatus("unpaired");
        }
      };

      ws.onmessage = (e) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const obj = msg as Record<string, unknown>;
        // Auth/pair lifecycle is handled here so the hook owns the state machine.
        if (obj.type === "pair.ok") {
          const device = obj.device as { id: string; name: string };
          deviceStore.setId(device.id);
          setDeviceName(device.name);
          // Re-auth with the freshly-minted device id, then clean the URL.
          const secret = deviceStore.getOrCreateSecret(() => generateSecret());
          ws.send(JSON.stringify({ type: "auth.device", deviceId: device.id, secretHash: secret }));
          window.history.replaceState(null, "", window.location.pathname);
          return;
        }
        if (obj.type === "auth.ok") {
          const device = obj.device as { name?: string } | undefined;
          if (device?.name) setDeviceName(device.name);
          setStatus("online");
          handlersRef.current.onServerEvent?.(msg as MobileServerEvent);
          return;
        }
        if (obj.type === "auth.failed" || obj.type === "pair.failed") {
          if (obj.type === "auth.failed") deviceStore.clearId();
          setStatus("unpaired");
          handlersRef.current.onServerEvent?.(msg as MobileServerEvent);
          return;
        }
        // Typed server events carry a string `type`; raw worker lines carry a
        // `method` (agent/streamEvent, agent/approvalRequest, …). Route both.
        if (typeof obj.type === "string") {
          handlersRef.current.onServerEvent?.(msg as MobileServerEvent);
        }
        if (typeof obj.method === "string") {
          handlersRef.current.onRawLine?.(msg);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (closedByUs.current) return;
        setStatus("offline");
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryRef.current, RECONNECT_MAX_MS);
        retryRef.current += 1;
        retryTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose handles retry; closing here makes the failure deterministic.
        ws.close();
      };
    };

    connect();
    return () => {
      closedByUs.current = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  return { status, deviceName, send, logout };
}
