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
    let openWatchdog: ReturnType<typeof setTimeout> | undefined;

    /** Schedule a reconnect with jittered exponential backoff. Cancels any
     *  pending timer so a manual/event-driven reconnect can pre-empt it. */
    const scheduleReconnect = (): void => {
      if (closedByUs.current) return;
      if (retryTimer) clearTimeout(retryTimer);
      const base = Math.min(RECONNECT_BASE_MS * 2 ** retryRef.current, RECONNECT_MAX_MS);
      // Full jitter: random in [base/2, base] avoids thundering-herd and makes
      // a flaky network settle instead of hammering on a fixed cadence.
      const delay = base / 2 + Math.random() * (base / 2);
      retryRef.current += 1;
      retryTimer = setTimeout(connect, delay);
    };

    /** Force an immediate reconnect (network back / tab visible again). */
    const reconnectNow = (): void => {
      if (closedByUs.current) return;
      const ws = wsRef.current;
      // If we already have a live, open socket, leave it alone.
      if (ws && ws.readyState === WebSocket.OPEN) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryRef.current = 0;
      // Drop a half-open/connecting socket before redialing.
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
      connect();
    };

    const connect = (): void => {
      const wsUrl = window.location.origin.replace(/^http/, "ws") + "/ws";
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      setStatus("connecting");
      // Watchdog: a socket stuck in CONNECTING (dead network, captive portal)
      // never fires onclose. Force-close after 10s so backoff kicks in.
      if (openWatchdog) clearTimeout(openWatchdog);
      openWatchdog = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      }, 10_000);

      ws.onopen = () => {
        if (openWatchdog) clearTimeout(openWatchdog);
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
        if (openWatchdog) clearTimeout(openWatchdog);
        wsRef.current = null;
        if (closedByUs.current) return;
        setStatus("offline");
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose handles retry; closing here makes the failure deterministic.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    // Reconnect proactively when the OS reports the network is back or the tab
    // becomes visible again (phones suspend the socket in the background — the
    // close event often doesn't fire until the user returns).
    const onOnline = () => reconnectNow();
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    connect();
    return () => {
      closedByUs.current = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (openWatchdog) clearTimeout(openWatchdog);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      // Null ALL handlers before close: onmessage/onopen call setState without the
      // closedByUs guard the close/error paths have, so an event landing in the
      // close window would setState on the unmounted component. (Mirrors the
      // reconnectNow teardown above, which already nulls handlers.)
      const ws = wsRef.current;
      if (ws) {
        ws.onmessage = null;
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
    };
  }, []);

  return { status, deviceName, send, logout };
}
