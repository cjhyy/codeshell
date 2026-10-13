import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-core";
import { deviceStore } from "../lib/storage.js";
import { generateSecret } from "../lib/deviceCredential.js";
import { parsePairingToken } from "../lib/pairing.js";
import { ConnectionLiveness, connectionPageHidden } from "../lib/connectionLiveness.js";

export type ConnStatus =
  | "connecting" // socket opening
  | "authenticating" // socket open, handshake sent
  | "unpaired" // no deviceId and no pairing token → must scan QR
  | "online" // authenticated
  | "offline"; // socket closed, will retry

export type ResyncReason = "online" | "visible" | "focus" | "pageshow";

/** A parsed server event (typed) OR a raw worker→renderer JSON-RPC line that the
 *  caller folds through streamReducer. We surface both: typed events drive UI
 *  state; raw lines drive the chat reducer. */
export interface RemoteSocket {
  status: ConnStatus;
  deviceName: string;
  /** Monotonic id of the currently authenticated socket. */
  connectionGeneration: number;
  /** Send only on an authenticated socket, optionally requiring the captured generation. */
  send: (event: MobileClientEvent, expectedGeneration?: number) => boolean;
  /** Manually drop credentials and return to the pairing screen. */
  logout: () => void;
}

export interface RemoteSocketHandlers {
  /** A typed server event (auth/session/approval/room/…). */
  onServerEvent?: (event: MobileServerEvent) => void;
  /** Any raw line (used to fold agent/streamEvent through streamReducer). */
  onRawLine?: (raw: unknown) => void;
  /** The transport is usable again, or the page returned from background. */
  onResyncNeeded?: (reason: ResyncReason) => void;
}

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 8000;

export function useRemoteSocket(handlers: RemoteSocketHandlers): RemoteSocket {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [deviceName, setDeviceName] = useState<string>("");
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const connectionGenerationRef = useRef(0);
  const retryRef = useRef(0);
  const closedByUs = useRef(false);
  const stopSocket = useRef<(() => void) | undefined>(undefined);
  const statusRef = useRef<ConnStatus>(status);
  statusRef.current = status;
  // Keep latest handlers without retriggering the connect effect.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const send = useCallback((event: MobileClientEvent, expectedGeneration?: number): boolean => {
    const ws = wsRef.current;
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      statusRef.current !== "online" ||
      (expectedGeneration !== undefined && expectedGeneration !== connectionGenerationRef.current)
    ) {
      return false;
    }
    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    deviceStore.clearId();
    closedByUs.current = true;
    stopSocket.current?.();
    // Drop the pairing token from the URL and reload into the unpaired state.
    window.history.replaceState(null, "", window.location.pathname);
    statusRef.current = "unpaired";
    setStatus("unpaired");
  }, []);

  useEffect(() => {
    closedByUs.current = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let health: ConnectionLiveness | undefined;

    /** Schedule a reconnect with jittered exponential backoff. Cancels any
     *  pending timer so a manual/event-driven reconnect can pre-empt it. */
    const scheduleReconnect = (): void => {
      if (closedByUs.current || connectionPageHidden()) return;
      if (retryTimer) clearTimeout(retryTimer);
      const base = Math.min(RECONNECT_BASE_MS * 2 ** retryRef.current, RECONNECT_MAX_MS);
      // Full jitter: random in [base/2, base] avoids thundering-herd and makes
      // a flaky network settle instead of hammering on a fixed cadence.
      const delay = base / 2 + Math.random() * (base / 2);
      retryRef.current += 1;
      retryTimer = setTimeout(connect, delay);
    };

    const retire = (ws: WebSocket, retry = true): void => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      health?.stop();
      health = undefined;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already unusable */
      }
      if (!closedByUs.current) {
        statusRef.current = "offline";
        setStatus("offline");
        if (retry) scheduleReconnect();
      }
    };

    /** Force an immediate reconnect (network back / tab visible again). */
    const reconnectNow = (): void => {
      if (closedByUs.current) return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        health?.resume();
        return;
      }
      if (retryTimer) clearTimeout(retryTimer);
      retryRef.current = 0;
      if (ws) retire(ws, false);
      connect();
    };

    const connect = (): void => {
      if (closedByUs.current) return;
      retryTimer = undefined;
      const wsUrl = window.location.origin.replace(/^http/, "ws") + "/ws";
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      statusRef.current = "connecting";
      setStatus("connecting");
      const socketHealth = new ConnectionLiveness(
        // Existing read-only protocol, answered by the Host's disk index. Never
        // manufacture a ping, repeat a chat send or retry an approval decision.
        () => ws.send(JSON.stringify({ type: "session.list" })),
        () => retire(ws),
        connectionPageHidden(),
      );
      health = socketHealth;

      ws.onopen = () => {
        if (wsRef.current !== ws || closedByUs.current) return;
        socketHealth.authenticating();
        retryRef.current = 0;
        const pairingToken = parsePairingToken(window.location.search);
        const secret = deviceStore.getOrCreateSecret(() => generateSecret());
        const name = deviceStore.getOrCreateName();
        setDeviceName(name);
        if (pairingToken) {
          statusRef.current = "authenticating";
          setStatus("authenticating");
          ws.send(
            JSON.stringify({
              type: "pair.complete",
              token: pairingToken,
              name,
              secretHash: secret,
            }),
          );
        } else if (deviceStore.getId()) {
          statusRef.current = "authenticating";
          setStatus("authenticating");
          ws.send(
            JSON.stringify({
              type: "auth.device",
              deviceId: deviceStore.getId(),
              secretHash: secret,
            }),
          );
        } else {
          socketHealth.stop();
          statusRef.current = "unpaired";
          setStatus("unpaired");
        }
      };

      ws.onmessage = (e) => {
        if (wsRef.current !== ws || closedByUs.current) return;
        let msg: unknown;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
        const obj = msg as Record<string, unknown>;
        // This legacy protocol has no request id on session.list. Only its
        // concrete response (or an uncorrelated control rejection) can answer
        // a health check; stream/approval notifications cannot clear a deadline.
        if (
          obj.type === "session.list.ok" ||
          (obj.type === "error" &&
            !obj.approvalId &&
            !obj.clientMessageId &&
            !obj.clientRequestId &&
            !obj.sessionId &&
            !obj.roomId)
        )
          socketHealth.received();
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
          socketHealth.connected();
          const device = obj.device as { name?: string } | undefined;
          if (device?.name) setDeviceName(device.name);
          statusRef.current = "online";
          setStatus("online");
          connectionGenerationRef.current += 1;
          setConnectionGeneration(connectionGenerationRef.current);
          handlersRef.current.onServerEvent?.(msg as MobileServerEvent);
          handlersRef.current.onResyncNeeded?.("online");
          return;
        }
        if (obj.type === "auth.failed" || obj.type === "pair.failed") {
          closedByUs.current = true;
          if (obj.type === "auth.failed") deviceStore.clearId();
          statusRef.current = "unpaired";
          setStatus("unpaired");
          handlersRef.current.onServerEvent?.(msg as MobileServerEvent);
          retire(ws, false);
          stopSocket.current?.();
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

      ws.onclose = (event) => {
        if (wsRef.current !== ws) return;
        if (event?.code === 4401 || event?.code === 4403) {
          closedByUs.current = true;
          deviceStore.clearId();
          statusRef.current = "unpaired";
          setStatus("unpaired");
        }
        retire(ws);
        if (closedByUs.current) stopSocket.current?.();
      };

      ws.onerror = () => {
        retire(ws);
      };
    };

    // Reconnect proactively when the OS reports the network is back or the tab
    // becomes visible again (phones suspend the socket in the background — the
    // close event often doesn't fire until the user returns).
    const resyncOrReconnect = (reason: ResyncReason): void => {
      if (closedByUs.current || connectionPageHidden()) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && statusRef.current === "online") {
        health?.resume();
        handlersRef.current.onResyncNeeded?.(reason);
        return;
      }
      reconnectNow();
    };
    const onOnline = () => resyncOrReconnect("online");
    const onVisible = () => {
      if (document.visibilityState === "visible") resyncOrReconnect("visible");
      else {
        health?.pause();
        if (retryTimer) clearTimeout(retryTimer);
      }
    };
    const onFocus = () => resyncOrReconnect("focus");
    const onPageShow = () => resyncOrReconnect("pageshow");
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);

    connect();
    const stop = () => {
      closedByUs.current = true;
      if (retryTimer) clearTimeout(retryTimer);
      health?.stop();
      health = undefined;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
      const ws = wsRef.current;
      if (ws) retire(ws, false);
    };
    stopSocket.current = stop;
    return () => {
      stop();
      if (stopSocket.current === stop) stopSocket.current = undefined;
    };
  }, []);

  return { status, deviceName, connectionGeneration, send, logout };
}
