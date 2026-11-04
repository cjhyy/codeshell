import { useEffect, useState } from "react";
import type { DesktopRelayStatus } from "../../shared/device-relay.js";

/** Other computers are reachable only through an account-enrolled relay that is connected. */
export function accountDeviceEntryAvailable(status: DesktopRelayStatus | undefined): boolean {
  return Boolean(status?.registered && status.accountId && status.state === "ready");
}

export function useAccountDeviceEntry(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const relay = window.codeshell?.mobileRemote?.relay;
    if (!relay) return;
    let cancelled = false;
    const apply = (status: DesktopRelayStatus) => {
      if (!cancelled) setAvailable(accountDeviceEntryAvailable(status));
    };
    const off = relay.onStatus(apply);
    relay.status().then(apply, () => apply({ state: "unavailable", registered: false }));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return available;
}
